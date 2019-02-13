/**
 *
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Timestamp } from '../api/timestamp';
import { Query } from '../core/query';
import { BatchId, ProtoByteString } from '../core/types';
import { DocumentKeySet } from '../model/collections';
import { DocumentKey } from '../model/document_key';
import { Mutation } from '../model/mutation';
import { MutationBatch } from '../model/mutation_batch';
import { emptyByteString } from '../platform/platform';
import { assert } from '../util/assert';
import { primitiveComparator } from '../util/misc';
import { SortedMap } from '../util/sorted_map';
import { SortedSet } from '../util/sorted_set';

import { MutationQueue } from './mutation_queue';
import { PersistenceTransaction, ReferenceDelegate } from './persistence';
import { PersistencePromise } from './persistence_promise';
import { DocReference } from './reference_set';

import { AnyJs } from '../../src/util/misc';

export class MemoryMutationQueue implements MutationQueue {
  /**
   * The set of all mutations that have been sent but not yet been applied to
   * the backend.
   */
  private mutationQueue: MutationBatch[] = [];

  /** Next value to use when assigning sequential IDs to each mutation batch. */
  private nextBatchId: BatchId = 1;

  /** The last received stream token from the server, used to acknowledge which
   * responses the client has processed. Stream tokens are opaque checkpoint
   * markers whose only real value is their inclusion in the next request.
   */
  private lastStreamToken: ProtoByteString = emptyByteString();

  /** An ordered mapping between documents and the mutations batch IDs. */
  private batchesByDocumentKey = new SortedSet(DocReference.compareByKey);

  constructor(private readonly referenceDelegate: ReferenceDelegate) {}

  checkEmpty(transaction: PersistenceTransaction): PersistencePromise<boolean> {
    return PersistencePromise.resolve(this.mutationQueue.length === 0);
  }

  acknowledgeBatch(
    transaction: PersistenceTransaction,
    batch: MutationBatch,
    streamToken: ProtoByteString
  ): PersistencePromise<void> {
    const batchId = batch.batchId;
    const batchIndex = this.indexOfExistingBatchId(batchId, 'acknowledged');
    assert(
      batchIndex === 0,
      'Can only acknowledge the first batch in the mutation queue'
    );

    // Verify that the batch in the queue is the one to be acknowledged.
    const check = this.mutationQueue[batchIndex];
    assert(
      batchId === check.batchId,
      'Queue ordering failure: expected batch ' +
        batchId +
        ', got batch ' +
        check.batchId
    );

    this.lastStreamToken = streamToken;
    return PersistencePromise.resolve();
  }

  getLastStreamToken(
    transaction: PersistenceTransaction
  ): PersistencePromise<ProtoByteString> {
    return PersistencePromise.resolve(this.lastStreamToken);
  }

  setLastStreamToken(
    transaction: PersistenceTransaction,
    streamToken: ProtoByteString
  ): PersistencePromise<void> {
    this.lastStreamToken = streamToken;
    return PersistencePromise.resolve();
  }

  addMutationBatch(
    transaction: PersistenceTransaction,
    localWriteTime: Timestamp,
    mutations: Mutation[]
  ): PersistencePromise<MutationBatch> {
    assert(mutations.length !== 0, 'Mutation batches should not be empty');

    const batchId = this.nextBatchId;
    this.nextBatchId++;

    if (this.mutationQueue.length > 0) {
      const prior = this.mutationQueue[this.mutationQueue.length - 1];
      assert(
        prior.batchId < batchId,
        'Mutation batchIDs must be monotonically increasing order'
      );
    }

    const batch = new MutationBatch(batchId, localWriteTime, mutations);
    this.mutationQueue.push(batch);

    // Track references by document key.
    for (const mutation of mutations) {
      this.batchesByDocumentKey = this.batchesByDocumentKey.add(
        new DocReference(mutation.key, batchId)
      );
    }

    return PersistencePromise.resolve(batch);
  }

  lookupMutationBatch(
    transaction: PersistenceTransaction,
    batchId: BatchId
  ): PersistencePromise<MutationBatch | null> {
    return PersistencePromise.resolve(this.findMutationBatch(batchId));
  }

  lookupMutationKeys(
    transaction: PersistenceTransaction,
    batchId: BatchId
  ): PersistencePromise<DocumentKeySet | null> {
    const mutationBatch = this.findMutationBatch(batchId);
    assert(mutationBatch != null, 'Failed to find local mutation batch.');
    return PersistencePromise.resolve<DocumentKeySet | null>(
      mutationBatch!.keys()
    );
  }

  getNextMutationBatchAfterBatchId(
    transaction: PersistenceTransaction,
    batchId: BatchId
  ): PersistencePromise<MutationBatch | null> {
    const nextBatchId = batchId + 1;

    // The requested batchId may still be out of range so normalize it to the
    // start of the queue.
    const rawIndex = this.indexOfBatchId(nextBatchId);
    const index = rawIndex < 0 ? 0 : rawIndex;
    return PersistencePromise.resolve(
      this.mutationQueue.length > index ? this.mutationQueue[index] : null
    );
  }

  getAllMutationBatches(
    transaction: PersistenceTransaction
  ): PersistencePromise<MutationBatch[]> {
    return PersistencePromise.resolve(this.mutationQueue.slice());
  }

  getAllMutationBatchesAffectingDocumentKey(
    transaction: PersistenceTransaction,
    documentKey: DocumentKey
  ): PersistencePromise<MutationBatch[]> {
    const start = new DocReference(documentKey, 0);
    const end = new DocReference(documentKey, Number.POSITIVE_INFINITY);
    const result: MutationBatch[] = [];
    this.batchesByDocumentKey.forEachInRange([start, end], ref => {
      assert(
        documentKey.isEqual(ref.key),
        "Should only iterate over a single key's batches"
      );
      const batch = this.findMutationBatch(ref.targetOrBatchId);
      assert(
        batch !== null,
        'Batches in the index must exist in the main table'
      );
      result.push(batch!);
    });

    return PersistencePromise.resolve(result);
  }

  getAllMutationBatchesAffectingDocumentKeys(
    transaction: PersistenceTransaction,
    documentKeys: SortedMap<DocumentKey, AnyJs>
  ): PersistencePromise<MutationBatch[]> {
    let uniqueBatchIDs = new SortedSet<number>(primitiveComparator);

    documentKeys.forEach(documentKey => {
      const start = new DocReference(documentKey, 0);
      const end = new DocReference(documentKey, Number.POSITIVE_INFINITY);
      this.batchesByDocumentKey.forEachInRange([start, end], ref => {
        assert(
          documentKey.isEqual(ref.key),
          "For each key, should only iterate over a single key's batches"
        );

        uniqueBatchIDs = uniqueBatchIDs.add(ref.targetOrBatchId);
      });
    });

    return PersistencePromise.resolve(this.findMutationBatches(uniqueBatchIDs));
  }

  getAllMutationBatchesAffectingQuery(
    transaction: PersistenceTransaction,
    query: Query
  ): PersistencePromise<MutationBatch[]> {
    // Use the query path as a prefix for testing if a document matches the
    // query.
    const prefix = query.path;
    const immediateChildrenPathLength = prefix.length + 1;

    // Construct a document reference for actually scanning the index. Unlike
    // the prefix the document key in this reference must have an even number of
    // segments. The empty segment can be used a suffix of the query path
    // because it precedes all other segments in an ordered traversal.
    let startPath = prefix;
    if (!DocumentKey.isDocumentKey(startPath)) {
      startPath = startPath.child('');
    }

    const start = new DocReference(new DocumentKey(startPath), 0);

    // Find unique batchIDs referenced by all documents potentially matching the
    // query.
    let uniqueBatchIDs = new SortedSet<number>(primitiveComparator);

    this.batchesByDocumentKey.forEachWhile(ref => {
      const rowKeyPath = ref.key.path;
      if (!prefix.isPrefixOf(rowKeyPath)) {
        return false;
      } else {
        // Rows with document keys more than one segment longer than the query
        // path can't be matches. For example, a query on 'rooms' can't match
        // the document /rooms/abc/messages/xyx.
        // TODO(mcg): we'll need a different scanner when we implement
        // ancestor queries.
        if (rowKeyPath.length === immediateChildrenPathLength) {
          uniqueBatchIDs = uniqueBatchIDs.add(ref.targetOrBatchId);
        }
        return true;
      }
    }, start);

    return PersistencePromise.resolve(this.findMutationBatches(uniqueBatchIDs));
  }

  private findMutationBatches(batchIDs: SortedSet<number>): MutationBatch[] {
    // Construct an array of matching batches, sorted by batchID to ensure that
    // multiple mutations affecting the same document key are applied in order.
    const result: MutationBatch[] = [];
    batchIDs.forEach(batchId => {
      const batch = this.findMutationBatch(batchId);
      if (batch !== null) {
        result.push(batch);
      }
    });
    return result;
  }

  removeMutationBatch(
    transaction: PersistenceTransaction,
    batch: MutationBatch
  ): PersistencePromise<void> {
    // Find the position of the first batch for removal. This need not be the
    // first entry in the queue.
    const batchIndex = this.indexOfExistingBatchId(batch.batchId, 'removed');
    assert(
      batchIndex === 0,
      'Can only remove the first entry of the mutation queue'
    );
    this.mutationQueue.shift();

    let references = this.batchesByDocumentKey;
    return PersistencePromise.forEach(batch.mutations, mutation => {
      const ref = new DocReference(mutation.key, batch.batchId);
      references = references.delete(ref);
      return this.referenceDelegate.removeMutationReference(
        transaction,
        mutation.key
      );
    }).next(() => {
      this.batchesByDocumentKey = references;
    });
  }

  removeCachedMutationKeys(batchId: BatchId): void {
    // No-op since the memory mutation queue does not maintain a separate cache.
  }

  containsKey(
    txn: PersistenceTransaction,
    key: DocumentKey
  ): PersistencePromise<boolean> {
    const ref = new DocReference(key, 0);
    const firstRef = this.batchesByDocumentKey.firstAfterOrEqual(ref);
    return PersistencePromise.resolve(key.isEqual(firstRef && firstRef.key));
  }

  performConsistencyCheck(
    txn: PersistenceTransaction
  ): PersistencePromise<void> {
    if (this.mutationQueue.length === 0) {
      assert(
        this.batchesByDocumentKey.isEmpty(),
        'Document leak -- detected dangling mutation references when queue is empty.'
      );
    }
    return PersistencePromise.resolve();
  }

  /**
   * Finds the index of the given batchId in the mutation queue and asserts that
   * the resulting index is within the bounds of the queue.
   *
   * @param batchId The batchId to search for
   * @param action A description of what the caller is doing, phrased in passive
   * form (e.g. "acknowledged" in a routine that acknowledges batches).
   */
  private indexOfExistingBatchId(batchId: BatchId, action: string): number {
    const index = this.indexOfBatchId(batchId);
    assert(
      index >= 0 && index < this.mutationQueue.length,
      'Batches must exist to be ' + action
    );
    return index;
  }

  /**
   * Finds the index of the given batchId in the mutation queue. This operation
   * is O(1).
   *
   * @return The computed index of the batch with the given batchId, based on
   * the state of the queue. Note this index can be negative if the requested
   * batchId has already been remvoed from the queue or past the end of the
   * queue if the batchId is larger than the last added batch.
   */
  private indexOfBatchId(batchId: BatchId): number {
    if (this.mutationQueue.length === 0) {
      // As an index this is past the end of the queue
      return 0;
    }

    // Examine the front of the queue to figure out the difference between the
    // batchId and indexes in the array. Note that since the queue is ordered
    // by batchId, if the first batch has a larger batchId then the requested
    // batchId doesn't exist in the queue.
    const firstBatchId = this.mutationQueue[0].batchId;
    return batchId - firstBatchId;
  }

  /**
   * A version of lookupMutationBatch that doesn't return a promise, this makes
   * other functions that uses this code easier to read and more efficent.
   */
  private findMutationBatch(batchId: BatchId): MutationBatch | null {
    const index = this.indexOfBatchId(batchId);
    if (index < 0 || index >= this.mutationQueue.length) {
      return null;
    }

    const batch = this.mutationQueue[index];
    assert(batch.batchId === batchId, 'If found batch must match');
    return batch;
  }
}

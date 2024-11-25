import { SharedLock } from './shared-lock';
import { cheap_guid, console_with_prefix, localStorageSupported, JSONParse, JSONStringify, _ } from './utils'; // eslint-disable-line camelcase

var logger = console_with_prefix('batch');

/**
 * RequestQueue: queue for batching API requests with localStorage backup for retries.
 * Maintains an in-memory queue which represents the source of truth for the current
 * page, but also writes all items out to a copy in the browser's localStorage, which
 * can be read on subsequent pageloads and retried. For batchability, all the request
 * items in the queue should be of the same type (events, people updates, group updates)
 * so they can be sent in a single request to the same API endpoint.
 *
 * LocalStorage keying and locking: In order for reloads and subsequent pageloads of
 * the same site to access the same persisted data, they must share the same localStorage
 * key (for instance based on project token and queue type). Therefore access to the
 * localStorage entry is guarded by an asynchronous mutex (SharedLock) to prevent
 * simultaneously open windows/tabs from overwriting each other's data (which would lead
 * to data loss in some situations).
 * @constructor
 */
var RequestQueue = function(storageKey, options) {
    options = options || {};
    this.storageKey = storageKey;
    this.usePersistence = options.usePersistence;
    if (this.usePersistence) {
        this.storage = options.storage || window.localStorage;
        this.lock = new SharedLock(storageKey, {storage: this.storage});
    }
    this.reportError = options.errorReporter || _.bind(logger.error, logger);

    this.pid = options.pid || null; // pass pid to test out storage lock contention scenarios

    this.memQueue = [];
};

/**
 * Add one item to queues (memory and localStorage). The queued entry includes
 * the given item along with an auto-generated ID and a "flush-after" timestamp.
 * It is expected that the item will be sent over the network and dequeued
 * before the flush-after time; if this doesn't happen it is considered orphaned
 * (e.g., the original tab where it was enqueued got closed before it could be
 * sent) and the item can be sent by any tab that finds it in localStorage.
 *
 * The final callback param is called with a param indicating success or
 * failure of the enqueue operation; it is asynchronous because the localStorage
 * lock is asynchronous.
 */
RequestQueue.prototype.enqueue = function(item, flushInterval, cb) {
    var queueEntry = {
        'id': cheap_guid(),
        'flushAfter': new Date().getTime() + flushInterval * 2,
        'payload': item
    };

    if (!this.usePersistence) {
        this.memQueue.push(queueEntry);
        if (cb) {
            cb(true);
        }
    } else {
        this.lock.withLock(_.bind(function lockAcquired() {
            var succeeded;
            try {
                var storedQueue = this.readFromStorage();
                storedQueue.push(queueEntry);
                succeeded = this.saveToStorage(storedQueue);
                if (succeeded) {
                    // only add to in-memory queue when storage succeeds
                    this.memQueue.push(queueEntry);
                }
            } catch(err) {
                this.reportError('Error enqueueing item', item);
                succeeded = false;
            }
            if (cb) {
                cb(succeeded);
            }
        }, this), _.bind(function lockFailure(err) {
            this.reportError('Error acquiring storage lock', err);
            if (cb) {
                cb(false);
            }
        }, this), this.pid);
    }
};

/**
 * Read out the given number of queue entries. If this.memQueue
 * has fewer than batchSize items, then look for "orphaned" items
 * in the persisted queue (items where the 'flushAfter' time has
 * already passed).
 */
RequestQueue.prototype.fillBatch = function(batchSize) {
    var batch = this.memQueue.slice(0, batchSize);
    if (this.usePersistence && batch.length < batchSize) {
        // don't need lock just to read events; localStorage is thread-safe
        // and the worst that could happen is a duplicate send of some
        // orphaned events, which will be deduplicated on the server side
        var storedQueue = this.readFromStorage();
        if (storedQueue.length) {
            // item IDs already in batch; don't duplicate out of storage
            var idsInBatch = {}; // poor man's Set
            _.each(batch, function(item) { idsInBatch[item['id']] = true; });

            for (var i = 0; i < storedQueue.length; i++) {
                var item = storedQueue[i];
                if (new Date().getTime() > item['flushAfter'] && !idsInBatch[item['id']]) {
                    item.orphaned = true;
                    batch.push(item);
                    if (batch.length >= batchSize) {
                        break;
                    }
                }
            }
        }
    }
    return batch;
};

/**
 * Remove items with matching 'id' from array (immutably)
 * also remove any item without a valid id (e.g., malformed
 * storage entries).
 */
var filterOutIDsAndInvalid = function(items, idSet) {
    var filteredItems = [];
    _.each(items, function(item) {
        if (item['id'] && !idSet[item['id']]) {
            filteredItems.push(item);
        }
    });
    return filteredItems;
};

/**
 * Remove items with matching IDs from both in-memory queue
 * and persisted queue
 */
RequestQueue.prototype.removeItemsByID = function(ids, cb) {
    var idSet = {}; // poor man's Set
    _.each(ids, function(id) { idSet[id] = true; });

    this.memQueue = filterOutIDsAndInvalid(this.memQueue, idSet);
    if (!this.usePersistence) {
        if (cb) {
            cb(true);
        }
    } else {
        var removeFromStorage = _.bind(function() {
            var succeeded;
            try {
                var storedQueue = this.readFromStorage();
                storedQueue = filterOutIDsAndInvalid(storedQueue, idSet);
                succeeded = this.saveToStorage(storedQueue);

                // an extra check: did storage report success but somehow
                // the items are still there?
                if (succeeded) {
                    storedQueue = this.readFromStorage();
                    for (var i = 0; i < storedQueue.length; i++) {
                        var item = storedQueue[i];
                        if (item['id'] && !!idSet[item['id']]) {
                            this.reportError('Item not removed from storage');
                            return false;
                        }
                    }
                }
            } catch(err) {
                this.reportError('Error removing items', ids);
                succeeded = false;
            }
            return succeeded;
        }, this);

        this.lock.withLock(function lockAcquired() {
            var succeeded = removeFromStorage();
            if (cb) {
                cb(succeeded);
            }
        }, _.bind(function lockFailure(err) {
            var succeeded = false;
            this.reportError('Error acquiring storage lock', err);
            if (!localStorageSupported(this.storage, true)) {
                // Looks like localStorage writes have stopped working sometime after
                // initialization (probably full), and so nobody can acquire locks
                // anymore. Consider it temporarily safe to remove items without the
                // lock, since nobody's writing successfully anyway.
                succeeded = removeFromStorage();
                if (!succeeded) {
                    // OK, we couldn't even write out the smaller queue. Try clearing it
                    // entirely.
                    try {
                        this.storage.removeItem(this.storageKey);
                    } catch(err) {
                        this.reportError('Error clearing queue', err);
                    }
                }
            }
            if (cb) {
                cb(succeeded);
            }
        }, this), this.pid);
    }

};

// internal helper for RequestQueue.updatePayloads
var updatePayloads = function(existingItems, itemsToUpdate) {
    var newItems = [];
    _.each(existingItems, function(item) {
        var id = item['id'];
        if (id in itemsToUpdate) {
            var newPayload = itemsToUpdate[id];
            if (newPayload !== null) {
                item['payload'] = newPayload;
                newItems.push(item);
            }
        } else {
            // no update
            newItems.push(item);
        }
    });
    return newItems;
};

/**
 * Update payloads of given items in both in-memory queue and
 * persisted queue. Items set to null are removed from queues.
 */
RequestQueue.prototype.updatePayloads = function(itemsToUpdate, cb) {
    this.memQueue = updatePayloads(this.memQueue, itemsToUpdate);
    if (!this.usePersistence) {
        if (cb) {
            cb(true);
        }
    } else {
        this.lock.withLock(_.bind(function lockAcquired() {
            var succeeded;
            try {
                var storedQueue = this.readFromStorage();
                storedQueue = updatePayloads(storedQueue, itemsToUpdate);
                succeeded = this.saveToStorage(storedQueue);
            } catch(err) {
                this.reportError('Error updating items', itemsToUpdate);
                succeeded = false;
            }
            if (cb) {
                cb(succeeded);
            }
        }, this), _.bind(function lockFailure(err) {
            this.reportError('Error acquiring storage lock', err);
            if (cb) {
                cb(false);
            }
        }, this), this.pid);
    }

};

/**
 * Read and parse items array from localStorage entry, handling
 * malformed/missing data if necessary.
 */
RequestQueue.prototype.readFromStorage = function() {
    var storageEntry;
    try {
        storageEntry = this.storage.getItem(this.storageKey);
        if (storageEntry) {
            storageEntry = JSONParse(storageEntry);
            if (!_.isArray(storageEntry)) {
                this.reportError('Invalid storage entry:', storageEntry);
                storageEntry = null;
            }
        }
    } catch (err) {
        this.reportError('Error retrieving queue', err);
        storageEntry = null;
    }
    return storageEntry || [];
};

/**
 * Serialize the given items array to localStorage.
 */
RequestQueue.prototype.saveToStorage = function(queue) {
    try {
        this.storage.setItem(this.storageKey, JSONStringify(queue));
        return true;
    } catch (err) {
        this.reportError('Error saving queue', err);
        return false;
    }
};

/**
 * Clear out queues (memory and localStorage).
 */
RequestQueue.prototype.clear = function() {
    this.memQueue = [];

    if (this.usePersistence) {
        this.storage.removeItem(this.storageKey);
    }
};

export { RequestQueue };

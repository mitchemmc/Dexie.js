import { Dexie } from '../dexie';
import { DbSchema } from '../public/types/db-schema';
import { setProp, keys, slice, _global, isArray } from './utils';
import { Transaction } from '../transaction';
import { Version } from '../version';
import { IDBTransaction, IDBObjectStore, IDBDatabase } from '../public/types/indexeddb';
import { newScope } from '../helpers/promise';
import Promise, { PSD } from '../helpers/promise';
import { exceptions } from '../errors';
import { TableSchema } from '../public/types/table-schema';
import { IndexSpec } from '../public/types/index-spec';
import { hasIEDeleteObjectStoreBug } from '../globals/constants';
import { safariMultiStoreFix } from './quirks';
import { createIndexSpec, nameFromKeyPath } from '../helpers/index-spec';
import { createTableSchema } from '../helpers/table-schema';

export function setApiOnPlace(db: Dexie, objs: Object[], tableNames: string[], dbschema: DbSchema) {
  tableNames.forEach(tableName => {
    const schema = dbschema[tableName];
    objs.forEach(obj => {
      if (!(tableName in obj)) {
        if (obj === db.Transaction.prototype || obj instanceof db.Transaction) {
          // obj is a Transaction prototype (or prototype of a subclass to Transaction)
          // Make the API a getter that returns this.table(tableName)
          setProp(obj, tableName, { get(this: Transaction) { return this.table(tableName); } });
        } else {
          // Table will not be bound to a transaction (will use Dexie.currentTransaction)
          obj[tableName] = new db.Table(tableName, schema);
        }
      }
    });
  });
}

export function removeTablesApi(db: Dexie, objs: Object[]) {
  objs.forEach(obj => {
    for (let key in obj) {
      if (obj[key] instanceof db.Table) delete obj[key];
    }
  });
}

export function lowerVersionFirst(a: Version, b: Version) {
  return a._cfg.version - b._cfg.version;
}

export function runUpgraders (db: Dexie, oldVersion: number, idbtrans: IDBTransaction, reject) {
  const globalSchema = db._dbSchema;
  var trans = db._createTransaction('readwrite', db._storeNames, globalSchema);)
  trans.create(idbtrans);
  trans._completion.catch(reject);
  var rejectTransaction = trans._reject.bind(trans);
  newScope(() => {
      PSD.trans = trans;
      if (oldVersion === 0) {
          // Create tables:
          keys(globalSchema).forEach(tableName => {
              createTable(idbtrans, tableName, globalSchema[tableName].primKey, globalSchema[tableName].indexes);
          });
          Promise.follow(()=>db.on.populate.fire(trans)).catch(rejectTransaction);
      } else
          updateTablesAndIndexes(db, oldVersion, trans, idbtrans).catch(rejectTransaction);
  });
}

export type UpgradeQueueItem = (idbtrans: IDBTransaction)=>Promise | void;

export function updateTablesAndIndexes (db: Dexie, oldVersion, trans, idbtrans) {
  // Upgrade version to version, step-by-step from oldest to newest version.
  // Each transaction object will contain the table set that was current in that version (but also not-yet-deleted tables from its previous version)
  const queue: UpgradeQueueItem[] = [];
  const versions = db._versions;
  const oldVersionStruct = versions.filter(version => version._cfg.version === oldVersion)[0];
  if (!oldVersionStruct) throw new exceptions.Upgrade(
    "Dexie specification of currently installed DB version is missing");
  let globalSchema = db._dbSchema = oldVersionStruct._cfg.dbschema;
  let anyContentUpgraderHasRun = false;

  const versToRun = versions.filter(v => v._cfg.version > oldVersion);
  versToRun.forEach(version => {
      queue.push(()=>{
          const oldSchema = globalSchema;
          const newSchema = version._cfg.dbschema;
          adjustToExistingIndexNames(db, oldSchema, idbtrans);
          adjustToExistingIndexNames(db, newSchema, idbtrans);
          globalSchema = db._dbSchema = newSchema;
          const diff = getSchemaDiff(oldSchema, newSchema);     
          // Add tables           
          diff.add.forEach(tuple => {
              createTable(idbtrans, tuple[0], tuple[1].primKey, tuple[1].indexes);
          });
          // Change tables
          diff.change.forEach(change => {
              if (change.recreate) {
                  throw new exceptions.Upgrade("Not yet support for changing primary key");
              } else {
                  const store = idbtrans.objectStore(change.name);
                  // Add indexes
                  change.add.forEach(idx => addIndex(store, idx));
                  // Update indexes
                  change.change.forEach(idx => {
                      store.deleteIndex(idx.name);
                      addIndex(store, idx);
                  });
                  // Delete indexes
                  change.del.forEach(idxName => store.deleteIndex(idxName));
              }
          });
          const contentUpgrade = version._cfg.contentUpgrade;
          if (contentUpgrade) {
              anyContentUpgraderHasRun = true;
              return Promise.follow(()=>{
                contentUpgrade(trans);
              });
          }
      });
      queue.push(idbtrans => {
          if (!anyContentUpgraderHasRun || !hasIEDeleteObjectStoreBug) { // Dont delete old tables if ieBug is present and a content upgrader has run. Let tables be left in DB so far. This needs to be taken care of.
              const newSchema = version._cfg.dbschema;
              // Delete old tables
              deleteRemovedTables(newSchema, idbtrans);
          }
      });
  });

  // Now, create a queue execution engine
  function runQueue () {
      return queue.length ? Promise.resolve(queue.shift()(trans.idbtrans)).then(runQueue) :
          Promise.resolve();
  }
  
  return runQueue().then(()=>{
      createMissingTables(globalSchema, idbtrans); // At last, make sure to create any missing tables. (Needed by addons that add stores to DB without specifying version)
  });
}

export interface SchemaDiff {
  del: string[],
  add: [string, TableSchema][];
  change: TableSchemaDiff[]; 
}

export interface TableSchemaDiff {
  name: string,
  recreate: boolean,
  del: string[],
  add: IndexSpec[],
  change: IndexSpec[]
}

export function getSchemaDiff(oldSchema: DbSchema, newSchema: DbSchema): SchemaDiff {
  const diff: SchemaDiff = {
      del: [], // Array of table names
      add: [], // Array of [tableName, newDefinition]
      change: [] // Array of {name: tableName, recreate: newDefinition, del: delIndexNames, add: newIndexDefs, change: changedIndexDefs}
  };
  let table: string;
  for (table in oldSchema) {
      if (!newSchema[table]) diff.del.push(table);
  }
  for (table in newSchema) {
      const oldDef = oldSchema[table],
          newDef = newSchema[table];
      if (!oldDef) {
          diff.add.push([table, newDef]);
      } else {
          const change = {
              name: table,
              def: newDef,
              recreate: false,
              del: [],
              add: [],
              change: []
          };
          if (oldDef.primKey.src !== newDef.primKey.src) {
              // Primary key has changed. Remove and re-add table.
              change.recreate = true;
              diff.change.push(change);
          } else {
              // Same primary key. Just find out what differs:
              const oldIndexes = oldDef.idxByName;
              const newIndexes = newDef.idxByName;
              let idxName: string;
              for (idxName in oldIndexes) {
                  if (!newIndexes[idxName]) change.del.push(idxName);
              }
              for (idxName in newIndexes) {
                  const oldIdx = oldIndexes[idxName],
                      newIdx = newIndexes[idxName];
                  if (!oldIdx) change.add.push(newIdx);
                  else if (oldIdx.src !== newIdx.src) change.change.push(newIdx);
              }
              if (change.del.length > 0 || change.add.length > 0 || change.change.length > 0) {
                  diff.change.push(change);
              }
          }
      }
  }
  return diff;
}

export function createTable(
  idbtrans: IDBTransaction,
  tableName: string,
  primKey: IndexSpec,
  indexes: IndexSpec[]
) {
  const store = idbtrans.db.createObjectStore(
    tableName,
    primKey.keyPath ?
      {keyPath: primKey.keyPath, autoIncrement: primKey.auto} :
      {autoIncrement: primKey.auto}
    );
  indexes.forEach(idx => addIndex(store, idx));
  return store;
}

export function createMissingTables(newSchema: DbSchema, idbtrans: IDBTransaction) {
  keys(newSchema).forEach(tableName => {
    if (!idbtrans.db.objectStoreNames.contains(tableName)) {
      createTable(idbtrans, tableName, newSchema[tableName].primKey, newSchema[tableName].indexes);
    }
  });
}

export function deleteRemovedTables(newSchema: DbSchema, idbtrans: IDBTransaction) {
  for (var i = 0; i < idbtrans.db.objectStoreNames.length; ++i) {
      var storeName = idbtrans.db.objectStoreNames[i];
      if (newSchema[storeName] == null) {
          idbtrans.db.deleteObjectStore(storeName);
      }
  }
}

export function addIndex(store: IDBObjectStore, idx: IndexSpec) {
  store.createIndex(idx.name, idx.keyPath, { unique: idx.unique, multiEntry: idx.multi });
}

export function readGlobalSchema(db: Dexie, idbdb: IDBDatabase) {
  db.verno = idbdb.version / 10;
  const globalSchema = db._dbSchema = {};
  const dbStoreNames = db._storeNames = slice(idbdb.objectStoreNames, 0);
  if (dbStoreNames.length === 0) return; // Database contains no stores.
  const trans = idbdb.transaction(safariMultiStoreFix(dbStoreNames), 'readonly');
  dbStoreNames.forEach(storeName => {
      const store = trans.objectStore(storeName);
      let keyPath = store.keyPath;
      let dotted = keyPath && typeof keyPath === 'string' && keyPath.indexOf('.') !== -1;
      const primKey = createIndexSpec(nameFromKeyPath(keyPath), keyPath || "", false, false, !!store.autoIncrement, keyPath && typeof keyPath !== 'string', dotted);
      const indexes: IndexSpec[] = [];
      for (let j = 0; j < store.indexNames.length; ++j) {
          const idbindex = store.index(store.indexNames[j]);
          keyPath = idbindex.keyPath;
          dotted = keyPath && typeof keyPath === 'string' && keyPath.indexOf('.') !== -1;
          var index = createIndexSpec(idbindex.name, keyPath, !!idbindex.unique, !!idbindex.multiEntry, false, keyPath && typeof keyPath !== 'string', dotted);
          indexes.push(index);
      }
      globalSchema[storeName] = createTableSchema(storeName, primKey, indexes);
  });
  setApiOnPlace(db, [db._allTables], keys(globalSchema), globalSchema);
}

export function adjustToExistingIndexNames(db: Dexie, schema: DbSchema, idbtrans: IDBTransaction) {
  // Issue #30 Problem with existing db - adjust to existing index names when migrating from non-dexie db
  const storeNames = idbtrans.db.objectStoreNames;

  for (let i = 0; i < storeNames.length; ++i) {
      const storeName = storeNames[i];
      const store = idbtrans.objectStore(storeName);
      db._hasGetAll = 'getAll' in store;
      
      for (let j = 0; j < store.indexNames.length; ++j) {
          const indexName = store.indexNames[j];
          const keyPath = store.index(indexName).keyPath;
          const dexieName = typeof keyPath === 'string' ? keyPath : "[" + slice(keyPath).join('+') + "]";
          if (schema[storeName]) {
              const indexSpec = schema[storeName].idxByName[dexieName];
              if (indexSpec) indexSpec.name = indexName;
          }
      }
  }

  // Bug with getAll() on Safari ver<604 on Workers only, see discussion following PR #579
  if (/Safari/.test(navigator.userAgent) &&
      !/(Chrome\/|Edge\/)/.test(navigator.userAgent) &&
      _global.WorkerGlobalScope && _global instanceof _global.WorkerGlobalScope &&
      [].concat(navigator.userAgent.match(/Safari\/(\d*)/))[1] < 604)
  {
      db._hasGetAll = false;
  }    
}

export function parseIndexSyntax(indexes: string): IndexSpec[] {
  const rv = [];
  indexes.split(',').forEach(index => {
      index = index.trim();
      const name = index.replace(/([&*]|\+\+)/g, ""); // Remove "&", "++" and "*"
      // Let keyPath of "[a+b]" be ["a","b"]:
      const keyPath = /^\[/.test(name) ? name.match(/^\[(.*)\]$/)[1].split('+') : name;

      rv.push(createIndexSpec(
          name,
          keyPath || null,
          /\&/.test(index),
          /\*/.test(index),
          /\+\+/.test(index),
          isArray(keyPath),
          /\./.test(index)
      ));
  });
  return rv;
}

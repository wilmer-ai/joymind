import { MemoryRunStore, SqliteRunStore } from '../src/index.js';
import { runStoreContract } from './run-store.contract.js';

runStoreContract('MemoryRunStore', () => new MemoryRunStore());
runStoreContract('SqliteRunStore', () => new SqliteRunStore());

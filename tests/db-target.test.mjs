import test from 'node:test';
import assert from 'node:assert/strict';
import { disposableTarget } from './db-target.mjs';
test('database tests reject default/shared targets and accept explicit disposable targets',()=>{
  assert.throws(()=>disposableTarget({}),/disposable/);
  assert.throws(()=>disposableTarget({ASHER_CONNECT_ALLOW_DB_TESTS:'true',ASHER_CONNECT_TEST_CONTAINER:'supabase-db',ASHER_CONNECT_TEST_DATABASE:'postgres',ASHER_CONNECT_TEST_USER:'postgres'}),/disposable/);
  assert.equal(disposableTarget({ASHER_CONNECT_ALLOW_DB_TESTS:'true',ASHER_CONNECT_TEST_CONTAINER:'asher-gap-review-pg-20260922',ASHER_CONNECT_TEST_DATABASE:'asher_connect_sandbox',ASHER_CONNECT_TEST_USER:'test'}).database,'asher_connect_sandbox');
});

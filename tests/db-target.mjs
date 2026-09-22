export function disposableTarget(env=process.env) {
  const container=env.ASHER_CONNECT_TEST_CONTAINER;
  const database=env.ASHER_CONNECT_TEST_DATABASE;
  const user=env.ASHER_CONNECT_TEST_USER;
  if(env.ASHER_CONNECT_ALLOW_DB_TESTS!=='true'||!/^asher-(gap|test)-[a-z0-9-]+$/.test(container??'')||!/^asher_.*_sandbox$/.test(database??'')||!user){
    throw new Error('Database tests require an explicit disposable asher-gap-/asher-test- container, asher_*_sandbox database, user and ASHER_CONNECT_ALLOW_DB_TESTS=true');
  }
  return {container,database,user,adminUser:env.ASHER_CONNECT_TEST_ADMIN_USER||user};
}

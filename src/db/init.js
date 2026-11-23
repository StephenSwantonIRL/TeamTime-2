import { databaseConfig } from '../config.js';
import { connectMongo } from './mongo-store.js';
import { initializeDatabase } from './setup.js';

let client;
try {
  const { uri, databaseName } = databaseConfig();
  const connection = await connectMongo(uri, databaseName);
  client = connection.client;
  await initializeDatabase(connection.db);
  console.log('TeamTime database initialized.');
} catch {
  console.error('Database initialization failed. Check replica set connectivity and database permissions.');
  process.exitCode = 1;
} finally {
  await client?.close();
}

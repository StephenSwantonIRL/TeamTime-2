import { once } from 'node:events';
import { createApp } from './app.js';
import { serverConfig } from './config.js';
import { createDemoStore } from './db/demo-store.js';
import { createMailStore } from './db/mail-store.js';
import { connectMongo, createMongoStore } from './db/mongo-store.js';
import { initializeDatabase } from './db/setup.js';
import { createPowerAutomateService } from './invitations/power-automate.js';
import { startMailboxPoller } from './mail/sync.js';

let client;
let startupStep = 'configuration';
try {
  const config = serverConfig();
  const invitationService = config.invitations && createPowerAutomateService(config.invitations);
  let store;
  let mailStore;
  if (config.demo) {
    store = createDemoStore();
  } else {
    startupStep = 'database connection';
    const connection = await connectMongo(config.mongo.uri, config.mongo.databaseName);
    client = connection.client;
    startupStep = 'database setup';
    await initializeDatabase(connection.db);
    store = createMongoStore(client, connection.db, { sendInvitations: Boolean(invitationService) });
    if (config.mail) mailStore = createMailStore(client, connection.db);
  }

  startupStep = 'server listener';
  const server = createApp({ store, ...config, invitationService }).listen(config.port, config.host);
  await once(server, 'listening');
  const displayHost = config.host === '::1' ? '[::1]' : config.host;
  console.log(`TeamTime ${config.demo ? 'demo' : 'MongoDB mode'} listening at http://${displayHost}:${config.port}`);
  const stopPoller = mailStore ? startMailboxPoller(config.mail, mailStore) : undefined;

  function shutdown() {
    server.close(async () => {
      try { await stopPoller?.(); } finally { await client?.close(); }
    });
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  const details = {
    configuration: error.message,
    'database connection': 'Check the MONGODB_URI replica-set address, credentials, and network access.',
    'database setup': 'Check that the MongoDB user can create collections and indexes in the TeamTime database and update older validators if needed.',
    'server listener': error.code === 'EADDRINUSE' ? 'The configured port is in use.' : 'Check the configured host and port.',
  };
  console.error(`TeamTime could not start (${startupStep}). ${details[startupStep]}`);
  await client?.close();
  process.exitCode = 1;
}

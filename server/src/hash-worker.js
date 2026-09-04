// Worker thread: hashes passwords with bcrypt so a big import can use every CPU core.
import { parentPort } from 'node:worker_threads';
import bcrypt from 'bcryptjs';

parentPort.on('message', ({ id, passwords }) => {
  parentPort.postMessage({ id, hashes: passwords.map((p) => bcrypt.hashSync(p, 10)) });
});

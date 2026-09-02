// Server-Sent Events hub: keeps one open connection per signed-in client and
// pushes small "something changed" messages so the apps refresh instantly.
const clients = new Map(); // userId -> Set<res>

export function subscribe(userId, res) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  return () => {
    const set = clients.get(userId);
    if (set) {
      set.delete(res);
      if (set.size === 0) clients.delete(userId);
    }
  };
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function notifyUsers(userIds, event, data) {
  for (const id of userIds) {
    const set = clients.get(id);
    if (!set) continue;
    for (const res of set) send(res, event, data);
  }
}

export function notifyAll(event, data) {
  for (const set of clients.values()) for (const res of set) send(res, event, data);
}

// Heartbeat so proxies/mobile radios keep the connection open.
setInterval(() => {
  for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
}, 25000).unref();

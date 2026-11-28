// Usage:
//   node bulk-single-type.js
//   Optional CLI args: node bulk-single-type.js <sleep|echo|fail> [count] [sleepMs]

const BASE_URL = 'http://localhost:8080/api/v1';
const EMAIL = 'vivek1@yopmail.com';
const PASSWORD = 'Test@123';
const QUEUE_ID_OR_NAME = '3f908a79-2708-42c8-bb47-b6a76c5fdb5e';

// ---- Easy config: change JOB_TYPE & JOB_OPTIONS as needed ----
const JOB_TYPE = process.argv[2] ?? 'sleep'; // 'sleep' | 'echo' | 'fail'
const COUNT = Number(process.argv[3] ?? 20);
const CONCURRENCY = 5;

const JOB_OPTIONS = {
  sleepMs: Number(process.argv[4] ?? 4000), // used when JOB_TYPE === 'sleep'
  echoMessage: 'hello',                     // used when JOB_TYPE === 'echo'
  failMessage: 'Intentional test failure',  // used when JOB_TYPE === 'fail'
  failRetryable: true,                      // false => goes straight to FAILED
  delayMs: 0,                               // > 0 => starts as SCHEDULED
  priority: 0,
  maxAttempts: 3,
};

function buildJob(idx) {
  const common = {
    priority: JOB_OPTIONS.priority,
    maxAttempts: JOB_OPTIONS.maxAttempts,
    ...(JOB_OPTIONS.delayMs > 0 ? { delayMs: JOB_OPTIONS.delayMs } : {}),
  };

  if (JOB_TYPE === 'sleep') {
    return {
      ...common,
      name: 'system.sleep',
      payload: { ms: JOB_OPTIONS.sleepMs, index: idx },
    };
  }
  if (JOB_TYPE === 'echo') {
    return {
      ...common,
      name: 'system.echo',
      payload: { index: idx, msg: `${JOB_OPTIONS.echoMessage}-${idx}` },
    };
  }
  if (JOB_TYPE === 'fail') {
    return {
      ...common,
      name: 'system.fail',
      payload: {
        index: idx,
        message: `${JOB_OPTIONS.failMessage} #${idx}`,
        retryable: JOB_OPTIONS.failRetryable,
      },
    };
  }
  throw new Error(`Unsupported JOB_TYPE "${JOB_TYPE}". Use: sleep, echo, or fail`);
}

async function request(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`${method} ${path} failed (${res.status}): ${json?.error?.message}`);
  }
  return json.data;
}

const { accessToken: token } = await request('/auth/login', {
  method: 'POST',
  body: { email: EMAIL, password: PASSWORD },
});
console.log('Logged in');

const queues = await request('/queues?limit=100', { token });
const queue = queues.find((q) => q.id === QUEUE_ID_OR_NAME || q.name === QUEUE_ID_OR_NAME);
if (!queue) throw new Error(`Queue "${QUEUE_ID_OR_NAME}" not found`);
console.log(`Found queue: ${queue.name} (${queue.id})`);
console.log(`Submitting ${COUNT} "${JOB_TYPE}" jobs (concurrency=${CONCURRENCY})...`);

let ok = 0;
let fail = 0;

for (let i = 0; i < COUNT; i += CONCURRENCY) {
  const batch = Array.from({ length: Math.min(CONCURRENCY, COUNT - i) }, (_, j) => {
    const idx = i + j + 1;
    return request(`/queues/${queue.id}/jobs`, {
      method: 'POST',
      token,
      body: buildJob(idx),
    })
      .then(() => {
        ok += 1;
      })
      .catch((err) => {
        fail += 1;
        console.error(`Job #${idx}:`, err.message);
      });
  });

  await Promise.all(batch);
}

console.log(`Done! Created=${ok}, Failed=${fail}`);

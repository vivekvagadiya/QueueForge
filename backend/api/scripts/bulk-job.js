// Usage: node bulk-jobs.mjs
const BASE_URL = "http://localhost:8080/api/v1"; // Docker frontend proxy (ya http://localhost:4000/api/v1)
const EMAIL = "vivek1@yopmail.com";
const PASSWORD = "Test@123";
const QUEUE_NAME = "3f908a79-2708-42c8-bb47-b6a76c5fdb5e"; // Ya neeche QUEUE_ID directly set karein
const COUNT = 150; // Kitne jobs create karne hain (100, 200, etc.)
const CONCURRENCY = 2; // Ek saath kitni API requests bhejni hain

async function request(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok)
    throw new Error(
      `${method} ${path} failed (${res.status}): ${json?.error?.message}`,
    );
  return json.data;
}

// 1. Login
const { accessToken: token } = await request("/auth/login", {
  method: "POST",
  body: { email: EMAIL, password: PASSWORD },
});
console.log("Logged in");

// 2. Find existing queue by ID or name
const queues = await request("/queues?limit=100", { token });
const queue = queues.find((q) => q.id === QUEUE_NAME || q.name === QUEUE_NAME);
if (!queue) throw new Error(`Queue "${QUEUE_NAME}" not found`);
console.log(`Found queue: ${queue.name} (${queue.id})`);

// 3. Submit COUNT jobs in batches
let ok = 0;
let fail = 0;

for (let i = 0; i < COUNT; i += CONCURRENCY) {
  const batch = Array.from(
    { length: Math.min(CONCURRENCY, COUNT - i) },
    (_, j) => {
      const idx = i + j + 1;
      // Mix of echo, sleep, and occasional fail:
      const job =
        idx % 10 === 0
          ? { name: "system.fail", payload: { index: idx }, maxAttempts: 2 }
          : idx % 3 === 0
            ? { name: "system.sleep", payload: { ms: 1500, index: idx } }
            : {
                name: "system.echo",
                payload: { index: idx, msg: `hello-${idx}` },
              };

      return request(`/queues/${queue.id}/jobs`, {
        method: "POST",
        token,
        body: job,
      })
        .then(() => {
          ok += 1;
        })
        .catch((err) => {
          fail += 1;
          console.error(`Job #${idx}:`, err.message);
        });
    },
  );

  await Promise.all(batch);
}

console.log(`Done! Created=${ok}, Failed=${fail}`);

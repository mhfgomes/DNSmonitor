// Keep the worker CLI entry point while sharing lifecycle and notification delivery.
process.env.RUNTIME_ROLE = 'worker';
await import('../../api/src/main.js');
export {};

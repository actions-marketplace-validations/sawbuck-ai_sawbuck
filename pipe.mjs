// A reader that stops early (`sawbuck status | head -1`) closes the pipe. That is not an error: end quietly.
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); throw e; });

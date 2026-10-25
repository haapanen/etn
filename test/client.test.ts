import { describe, expect, it } from 'vitest';
import { ETClient } from '../src/client.js';

describe('connection cancellation', () => {
	it('rejects an already-aborted connection without opening a socket', async () => {
		const controller = new AbortController();
		controller.abort();
		const client = new ETClient({ host: '127.0.0.1' });

		await expect(client.connect({ signal: controller.signal })).rejects.toThrow('connection cancelled');
		expect(client.state).toBe('disconnected');
	});

	it('closes the socket and rejects when aborted during the handshake', async () => {
		const controller = new AbortController();
		const client = new ETClient({ host: '127.0.0.1', port: 27961 });
		const connecting = new Promise<void>((resolve) => {
			client.once('state', (state) => {
				if (state === 'connecting') resolve();
			});
		});

		const attempt = client.connect({ signal: controller.signal });
		await connecting;
		controller.abort();

		await expect(attempt).rejects.toThrow('connection cancelled');
		expect(client.state).toBe('disconnected');
	});
});

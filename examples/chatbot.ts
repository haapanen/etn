// Usage: ET_HOST=172.19.16.1 ET_DIR=/path/to/ET npm run example   (or ET_PAKS=a.pk3,b.pk3)
import { ETClient, stripColors } from '../src/index.js';

const client = new ETClient({
	host: process.env.ET_HOST ?? '127.0.0.1',
	port: Number(process.env.ET_PORT ?? 27960),
	name: process.env.ET_NAME ?? 'ChatBot',
	paks: process.env.ET_PAKS?.split(',').filter(Boolean),
	etDir: process.env.ET_DIR,
	log: (m) => console.error('[etn]', m),
});

client.on('state', (s, prev) => console.log(`state: ${prev} -> ${s}`));
client.on('disconnect', (reason) => console.log('disconnected:', reason));

// Every server command, for exploring what the server sends.
if (process.env.ET_DEBUG) client.onCommand('*', (c) => console.log('cmd>', c.raw));

client.onCommand('print', (c) => console.log('print:', stripColors(c.args[0] ?? '').trim()));

client.on('chat', (m) => {
	if (m.clientNum === client.clientNum) return;
	console.log(`${m.team ? '(team) ' : ''}${stripColors(m.sender)}: ${stripColors(m.message)}`);

	if (m.message.trim() === '!ping') client.say('pong');
	else if (m.message.trim() === '!players') client.say(`${client.players().length} players online`);
});

await client.connect();
console.log(`in game as client ${client.clientNum}, map ${client.serverInfo().mapname}`);
client.say('hello, I am a bot. Try !ping');

process.on('SIGINT', async () => {
	await client.disconnect();
	process.exit(0);
});

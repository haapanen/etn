#!/usr/bin/env node
import * as readline from 'node:readline';
import { parseArgs } from 'node:util';
import { ETClient } from './client.js';
import { stripColors, type ChatType } from './text.js';

const HELP = `Usage: etn-chat <host[:port]> [options]

Options:
  --name <name>     player name (default ETBot)
  --team <team>     join axis|allies after connecting (team chat is refused for spectators)
  --port <port>     server port (default 27960)
  --et-dir <dir>    ET install dir; pk3s the server lists (sv_pakNames) are taken from it for pure servers (env ET_DIR)
  --paks <a,b,..>   explicit pk3 paths for pure servers (env ET_PAKS)
  --no-color        disable ANSI colours
  --debug           print every server command and protocol log lines
  -h, --help        show this help

Inside the chat (plain text goes to the current channel):
  /say <text>           public chat
  /t <text>             team chat (you must be on a team)
  /f <text>             fireteam chat (you must be in a fireteam)
  /mode all|team|fireteam   channel for plain text
  /team axis|allies|spectator
  /fireteam <args>      e.g. /fireteam create, /fireteam invite 3, /fireteam leave
  /players              list players
  /raw <command>        send any client command
  /help, /quit`;

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		name: { type: 'string' },
		team: { type: 'string' },
		port: { type: 'string' },
		'et-dir': { type: 'string' },
		paks: { type: 'string' },
		'no-color': { type: 'boolean' },
		debug: { type: 'boolean' },
		help: { type: 'boolean', short: 'h' },
	},
});

if (values.help || positionals.length === 0) {
	console.log(HELP);
	process.exit(values.help ? 0 : 1);
}

const [hostArg] = positionals;
const [host, hostPort] = hostArg.split(':');
const port = Number(values.port ?? hostPort ?? 27960);
const etDir = values['et-dir'] ?? process.env.ET_DIR;
const pakList = values.paks ?? process.env.ET_PAKS;
const paks = pakList ? pakList.split(',').filter(Boolean) : [];

const useColor = !values['no-color'] && process.stdout.isTTY === true;
const ANSI: Record<string, number> = { '0': 90, '1': 31, '2': 32, '3': 33, '4': 34, '5': 36, '6': 35, '7': 37, '8': 33, '9': 90 };

function colorize(text: string): string {
	if (!useColor) return stripColors(text);
	const out = text.replace(/\^([^^])/g, (_, c: string) => (ANSI[c] ? `\x1b[${ANSI[c]}m` : ''));
	return `${out}\x1b[0m`;
}

const paint = (code: number, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.pause();
let mode: ChatType = 'public';
const updatePrompt = () => rl.setPrompt(`[${mode === 'public' ? 'all' : mode}]> `);
updatePrompt();

// Prints above the input line without clobbering what is being typed.
function out(line: string): void {
	if (process.stdout.isTTY) {
		readline.cursorTo(process.stdout, 0);
		readline.clearLine(process.stdout, 0);
	}
	console.log(line);
	if (process.stdout.isTTY) rl.prompt(true);
}

const client = new ETClient({
	host,
	port,
	name: values.name ?? 'ETBot',
	paks,
	etDir,
	log: values.debug ? (m) => out(paint(90, `[etn] ${m}`)) : undefined,
});

const CHANNEL_TAG: Record<ChatType, string> = {
	public: '[ALL]',
	team: paint(36, '[TEAM]'),
	fireteam: paint(33, '[FIRETEAM]'),
};

client.on('chat', (m) => {
	const sender = colorize(m.sender || '?');
	const where = m.location ? ` (${stripColors(m.location)})` : '';
	out(`${CHANNEL_TAG[m.type]} ${sender}${where}: ${colorize(m.message)}`);
});

const serverText = (s: string) => s.replace(/\[lo[fn]\]/g, '').trimEnd();
for (const name of ['print', 'cpm', 'cp']) {
	client.onCommand(name, (c) => {
		for (const line of serverText(c.args[0] ?? '').split('\n')) {
			if (line.trim()) out(`${paint(90, '[server]')} ${colorize(line)}`);
		}
	});
}

if (values.debug) {
	client.onCommand('*', (c) => {
		if (!['chat', 'tchat', 'print', 'cp', 'cpm', 'entnfo', 'sc0'].includes(c.name)) out(paint(90, `cmd> ${c.raw}`));
	});
}

client.on('gamestate', () => out(paint(90, `-- loaded map ${client.serverInfo().mapname ?? '?'}`)));
client.on('pureCheck', (files) => {
	if (files.length === 0) out(`${paint(33, '[pk3]')} server requires a pure check, but no pk3 files were configured`);
	else out(`${paint(90, '[pk3]')} files supplied for pure check: ${files.join(', ')}`);
});

let quitting = false;
const connectController = new AbortController();
let connected = false;
async function quit(code = 0): Promise<void> {
	if (quitting) return;
	quitting = true;
	await client.disconnect();
	rl.close();
	process.exit(code);
}

client.on('disconnect', (reason) => {
	if (quitting) return;
	out(`disconnected: ${reason}`);
	void quit(1);
});

const TEAM_NAMES: Record<string, string> = { '1': 'axis', '2': 'allies', '3': 'spectator' };
const TEAM_ARGS: Record<string, string> = { axis: 'axis', allies: 'allies', spectator: 'spectator', spec: 'spectator', s: 'spectator', a: 'axis', b: 'allies' };

function send(type: ChatType, text: string): void {
	if (type === 'public') client.say(text);
	else if (type === 'team') client.sayTeam(text);
	else client.sayFireteam(text);
}

function handle(line: string): void {
	if (!line.startsWith('/')) {
		send(mode, line);
		return;
	}
	const [cmd, ...rest] = line.slice(1).split(' ');
	const arg = rest.join(' ').trim();
	switch (cmd.toLowerCase()) {
		case 'say':
			send('public', arg);
			break;
		case 't':
			send('team', arg);
			break;
		case 'f':
			send('fireteam', arg);
			break;
		case 'mode': {
			const m = ({ all: 'public', public: 'public', team: 'team', fireteam: 'fireteam' } as Record<string, ChatType>)[arg];
			if (!m) return out('usage: /mode all|team|fireteam');
			mode = m;
			updatePrompt();
			out(`plain text now goes to ${arg} chat`);
			break;
		}
		case 'team': {
			const t = TEAM_ARGS[arg.toLowerCase()];
			if (!t) return out('usage: /team axis|allies|spectator');
			client.sendCommand(`team ${t}`);
			break;
		}
		case 'fireteam':
			client.sendCommand(`fireteam ${arg}`);
			break;
		case 'players':
			for (const p of client.players()) {
				const me = p.clientNum === client.clientNum ? ' (you)' : '';
				out(`${String(p.clientNum).padStart(2)}  ${colorize(p.name)}  ${TEAM_NAMES[p.team] ?? p.team}${me}`);
			}
			break;
		case 'raw':
			if (!arg) return out('usage: /raw <command>');
			client.sendCommand(arg);
			break;
		case 'help':
			out(HELP.split('\n\n').pop() ?? HELP);
			break;
		case 'quit':
		case 'exit':
			void quit(0);
			break;
		default:
			out(`unknown command /${cmd} (try /help)`);
	}
}

rl.on('line', (input) => {
	const line = input.trim();
	if (line) {
		try {
			handle(line);
		} catch (e) {
			out(`error: ${(e as Error).message}`);
		}
	}
	if (process.stdout.isTTY) rl.prompt(true);
});
// Piped input: give the server a moment to answer before leaving.
rl.on('close', () => {
	if (!quitting) setTimeout(() => void quit(0), 1500);
});
process.on('SIGINT', () => {
	if (!connected) {
		connectController.abort();
		return;
	}
	void quit(0);
});

try {
	console.log(`connecting to ${host}:${port} as ${values.name ?? 'ETBot'} ...`);
	await client.connect({ signal: connectController.signal });
	connected = true;
	out(`connected as client ${client.clientNum} on ${client.serverInfo().mapname ?? '?'} - type /help`);
	if (values.team) {
		const team = TEAM_ARGS[values.team.toLowerCase()];
		if (team) client.sendCommand(`team ${team}`);
		else out(`unknown team '${values.team}' (use axis, allies or spectator)`);
	}
	rl.prompt();
} catch (e) {
	if (connectController.signal.aborted) {
		console.log('connection cancelled');
		rl.close();
		process.exit(0);
	}
	console.error(`failed to connect: ${(e as Error).message}`);
	process.exit(1);
}

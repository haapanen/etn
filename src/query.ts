// One-shot connectionless queries (getinfo / getstatus / rcon) that don't need a session.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { decodeOOB, encodeOOB, type OOBMessage } from './oob.js';
import { parseInfo } from './text.js';

export interface QueryOptions {
	port?: number;
	/** Milliseconds to wait for a reply. */
	timeout?: number;
}

/** Sends one OOB packet and collects replies for which `collect` returns true until `done` says stop or the timeout hits. */
async function exchange(
	host: string,
	text: string,
	opts: QueryOptions,
	onMessage: (m: OOBMessage, finish: () => void) => void,
	quietMs?: number,
): Promise<void> {
	const port = opts.port ?? 27960;
	const timeout = opts.timeout ?? 2000;
	const { address } = await dns.lookup(host, 4);
	const socket = dgram.createSocket('udp4');
	await new Promise<void>((r) => socket.bind(0, r));

	await new Promise<void>((resolve, reject) => {
		let seen = false;
		let timer: NodeJS.Timeout | undefined;
		const finish = () => {
			clearTimeout(timer);
			resolve();
		};
		const arm = (ms: number, onTimeout: () => void) => {
			clearTimeout(timer);
			timer = setTimeout(onTimeout, ms);
		};
		socket.on('message', (buf, rinfo) => {
			if (rinfo.address !== address || rinfo.port !== port) return;
			const m = decodeOOB(buf);
			if (!m) return;
			seen = true;
			if (quietMs !== undefined) arm(quietMs, finish);
			onMessage(m, finish);
		});
		socket.on('error', reject);
		socket.send(encodeOOB(text), port, address);
		arm(timeout, () => (seen ? finish() : reject(new Error(`no reply from ${host}:${port}`))));
	}).finally(() => socket.close());
}

export async function getInfo(host: string, opts: QueryOptions = {}): Promise<Record<string, string>> {
	let result: Record<string, string> | undefined;
	await exchange(host, 'getinfo ' + Date.now(), opts, (m, finish) => {
		if (m.command.toLowerCase() !== 'inforesponse') return;
		result = parseInfo(m.data);
		finish();
	});
	if (!result) throw new Error('no infoResponse');
	return result;
}

export interface ServerStatus {
	info: Record<string, string>;
	players: { score: number; ping: number; name: string }[];
}

export async function getStatus(host: string, opts: QueryOptions = {}): Promise<ServerStatus> {
	let result: ServerStatus | undefined;
	await exchange(host, 'getstatus ' + Date.now(), opts, (m, finish) => {
		if (m.command.toLowerCase() !== 'statusresponse') return;
		const [infoLine = '', ...rest] = m.data.split('\n');
		const players = rest
			.map((l) => /^(-?\d+) (-?\d+) "(.*)"$/.exec(l))
			.filter((x): x is RegExpExecArray => x !== null)
			.map((x) => ({ score: Number(x[1]), ping: Number(x[2]), name: x[3] }));
		result = { info: parseInfo(infoLine), players };
		finish();
	});
	if (!result) throw new Error('no statusResponse');
	return result;
}

/** Runs an rcon command and returns the concatenated `print` output. The server rate-limits rcon to one per 500ms. */
export async function rcon(host: string, password: string, command: string, opts: QueryOptions = {}): Promise<string> {
	let out = '';
	await exchange(
		host,
		`rcon ${password} ${command}`,
		opts,
		(m) => {
			if (m.command.toLowerCase() === 'print') out += m.data;
		},
		300,
	);
	return out;
}

// Enemy Territory (protocol 84) client: connect handshake, netchan, gamestate, server commands.
//
// Snapshots are only read up to their header (time/flags): this client always sends `clc_moveNoDelta`,
// so the server never deltas against state we would have to keep, and the entity/player payload
// that follows the header is ignored.
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MsgReader, MsgWriter } from './msg.js';
import {
	MAX_RELIABLE_COMMANDS,
	Netchan,
	decodeServerMessage,
	encodeClientMessage,
} from './netchan.js';
import { decodeOOB, encodeConnectPacket, encodeOOB, isOOB, type OOBMessage } from './oob.js';
import { buildPureCommand, readPak, type PakInfo } from './pk3.js';
import { buildInfo, infoValue, parseChat, parseInfo, tokenize, type ChatMessage } from './text.js';

export const PROTOCOL_VERSION = 84;
export const CS_SERVERINFO = 0;
export const CS_SYSTEMINFO = 1;
export const CS_PLAYERS = 689;
export const MAX_CLIENTS = 64;
const MAX_CONFIGSTRINGS = 1024;
const MAX_GENTITIES_BITS = 10;
const RETRANSMIT_TIMEOUT = 3000;
const SNAPFLAG_NOT_ACTIVE = 2;
// Commands the server exempts from flood protection (sv_client.c SV_ClientCommand).
const FLOOD_EXEMPT = /^(team|setspawnpt|score|forcetapout\s*$)/i;

// svc_ops_e / clc_ops_e
const svc = { nop: 1, gamestate: 2, configstring: 3, baseline: 4, serverCommand: 5, download: 6, snapshot: 7, EOF: 8 };
const clc = { moveNoDelta: 3, clientCommand: 4, EOF: 5 };

// Bit widths of entityStateFields in msg.c; 0 marks a float field.
const ENTITY_FIELD_BITS: number[] = [
	8, 24, 8, 32, 32, 0, 0, 0, 0, 0, 0, 8, 32, 32, 0, 0, 0, 0, 0, 0, 32, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 10, 10,
	8, 32, 32, 9, 9, 16, 8, 24, 10, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 16, 8, 10, 10, 10, 32, 32, 32, 8, 8, 32, 32, 32, 4, 2,
];

export type ClientState = 'disconnected' | 'connecting' | 'challenging' | 'connected' | 'primed' | 'active';

export interface ServerCommand {
	seq: number;
	/** Full command text, e.g. `chat "Bob^7: ^2hi" 3 0`. */
	raw: string;
	name: string;
	/** Tokenized arguments (quotes removed). */
	args: string[];
}

export interface PlayerInfo {
	clientNum: number;
	name: string;
	team: string;
	info: Record<string, string>;
}

export interface ETClientOptions {
	host: string;
	port?: number;
	name?: string;
	/** Extra/overriding userinfo cvars sent in the connect packet. */
	userinfo?: Record<string, string | number>;
	qport?: number;
	/**
	 * pk3 files used to answer the pure-server check (`cp`). Together with the paks found via
	 * `etDir` they must include the pk3 holding the server's cgame/ui DLLs (mp_bin.pk3 on stock
	 * servers, the mod pk3 on mod servers). Not needed when the server runs sv_pure 0.
	 */
	paks?: string[];
	/**
	 * ET install dir. For a pure server, the paks it lists in `sv_pakNames` (e.g. `etjump/etjump-3.6.2`,
	 * `etmain/pak0`) are looked up as `<etDir>/<name>.pk3`; missing ones are skipped.
	 */
	etDir?: string;
	/** Interval between keepalive packets once in the game, in ms. */
	sendInterval?: number;
	/** Give up connecting after this many ms. */
	connectTimeout?: number;
	/**
	 * Minimum ms between client commands, to stay under the server's flood protection (it silently
	 * drops commands sent within 800 ms of the previous one). Extra commands are queued. 0 disables.
	 */
	commandInterval?: number;
	/** Drop the connection if the server is silent this long (cl_timeout). */
	timeout?: number;
	log?: (msg: string) => void;
}

interface ClientEvents {
	state: [state: ClientState, previous: ClientState];
	oob: [message: OOBMessage];
	gamestate: [info: { clientNum: number; serverId: number; checksumFeed: number }];
	/** PK3 paths whose checksums are being sent; empty when a pure server requires files but none are configured. */
	pureCheck: [files: string[]];
	active: [];
	serverCommand: [command: ServerCommand];
	chat: [message: ChatMessage];
	configstring: [index: number, value: string, previous: string];
	disconnect: [reason: string];
	error: [error: Error];
}

const now = () => Math.floor(performance.now());
const atoi = (s: string | undefined) => Number.parseInt(s ?? '', 10) | 0 || 0;

export class ETClient extends EventEmitter<ClientEvents> {
	readonly options: Required<Pick<ETClientOptions, 'host' | 'port' | 'sendInterval' | 'connectTimeout' | 'timeout' | 'commandInterval'>> &
		ETClientOptions;
	state: ClientState = 'disconnected';
	clientNum = -1;
	serverId = 0;
	checksumFeed = 0;
	readonly configstrings = new Map<number, string>();

	private socket: dgram.Socket | null = null;
	private serverAddress = '';
	private timer: NodeJS.Timeout | null = null;
	private netchan: Netchan | null = null;
	private readonly qport: number;
	private readonly guid = randomBytes(16).toString('hex').toUpperCase();

	private challenge = 0;
	private connectTime = -99999;
	private connectStart = 0;
	private lastPacketTime = 0;
	private lastPacketSentTime = -99999;

	private reliableSequence = 0;
	private reliableAcknowledge = 0;
	private readonly reliableCommands: string[] = new Array<string>(MAX_RELIABLE_COMMANDS).fill('');
	private serverCommandSequence = 0;
	private lastExecutedServerCommand = 0;
	private serverMessageSequence = 0;
	private readonly serverCommands: string[] = new Array<string>(MAX_RELIABLE_COMMANDS).fill('');
	private bigConfigString = '';

	private snapServerTime = 0;
	private serverTimeDelta = 0;
	private oldServerTime = 0;
	private extrapolatedSnapshot = false;
	private readonly pakCache = new Map<string, PakInfo>();
	private inflight = 0;
	private readonly outbox: string[] = [];
	private nextCommandTime = 0;

	private readonly commandHandlers = new Map<string, Set<(c: ServerCommand) => void>>();
	private readonly oobHandlers = new Map<string, Set<(m: OOBMessage) => void>>();
	private pending: { resolve: () => void; reject: (e: Error) => void } | null = null;

	constructor(options: ETClientOptions) {
		super();
		this.options = {
			port: 27960,
			sendInterval: 100,
			connectTimeout: 20000,
			timeout: 200000,
			commandInterval: 850,
			...options,
		};
		this.qport = options.qport ?? Math.floor(Math.random() * 0x10000);
	}

	// ---- public API -------------------------------------------------------------------------

	/** Connects and resolves once the server has put us in the game (first active snapshot). */
	async connect(options: { signal?: AbortSignal } = {}): Promise<void> {
		if (this.state !== 'disconnected') throw new Error(`already ${this.state}`);
		const { signal } = options;
		if (signal?.aborted) throw new Error('connection cancelled');

		try {
			const lookup = dns.lookup(this.options.host, 4);
			let onAbort: (() => void) | undefined;
			let address: string;
			try {
				({ address } = signal
					? await Promise.race([
							lookup,
							new Promise<never>((_, reject) => {
								onAbort = () => reject(new Error('connection cancelled'));
								signal.addEventListener('abort', onAbort, { once: true });
							}),
						])
					: await lookup);
			} finally {
				if (onAbort) signal?.removeEventListener('abort', onAbort);
			}
			if (signal?.aborted) throw new Error('connection cancelled');
			this.serverAddress = address;

			const socket = dgram.createSocket('udp4');
			this.socket = socket;
			socket.on('message', (msg, rinfo) => {
				if (rinfo.address === this.serverAddress && rinfo.port === this.options.port) this.onPacket(msg);
			});
			socket.on('error', (e) => this.fail(e));
			await new Promise<void>((resolve) => socket.bind(0, resolve));
			if (signal?.aborted) throw new Error('connection cancelled');

			this.resetConnection();
			this.connectStart = now();
			this.lastPacketTime = this.connectStart;
			this.setState('connecting');
			this.timer = setInterval(() => this.tick(), 25);
			if (signal?.aborted) throw new Error('connection cancelled');

			await new Promise<void>((resolve, reject) => {
				const cleanup = () => signal?.removeEventListener('abort', abort);
				const abort = () => void this.disconnect('connection cancelled');
				this.pending = {
					resolve: () => {
						cleanup();
						resolve();
					},
					reject: (error) => {
						cleanup();
						reject(error);
					},
				};
				signal?.addEventListener('abort', abort, { once: true });
				if (signal?.aborted) abort();
				this.tick();
			});
		} catch (error) {
			if (this.socket) await this.shutdown((error as Error).message);
			throw error;
		}
	}

	/** Leaves the server (sends `disconnect` a few times like the stock client) and closes the socket once flushed. */
	async disconnect(reason = 'disconnected'): Promise<void> {
		if (this.state === 'disconnected') return;
		if (this.netchan && this.state !== 'connecting' && this.state !== 'challenging') {
			try {
				this.addReliableCommand('disconnect');
				for (let i = 0; i < 3; i++) this.writePacket();
			} catch {
				// socket may already be unusable
			}
		}
		await this.shutdown(reason);
	}

	/** Sends a reliable client command such as `say "hi"` or `team allies`. */
	sendCommand(command: string): void {
		if (!this.netchan) throw new Error('not connected');
		if (FLOOD_EXEMPT.test(command)) {
			this.addReliableCommand(command);
			if (this.state === 'primed' || this.state === 'active') this.writePacket();
			return;
		}
		this.outbox.push(command);
		this.pumpOutbox(now());
	}

	private pumpOutbox(t: number): void {
		if (this.state !== 'primed' && this.state !== 'active') return;
		while (this.outbox.length > 0 && t >= this.nextCommandTime) {
			this.addReliableCommand(this.outbox.shift()!);
			this.nextCommandTime = t + this.options.commandInterval;
			this.writePacket();
		}
	}

	say(text: string): void {
		this.sendCommand(`say "${sanitize(text)}"`);
	}

	sayTeam(text: string): void {
		this.sendCommand(`say_team "${sanitize(text)}"`);
	}

	/** Fireteam chat; the server only delivers it if we are in a fireteam. */
	sayFireteam(text: string): void {
		this.sendCommand(`say_buddy "${sanitize(text)}"`);
	}

	/** Sends a connectionless packet to the server (e.g. `getstatus`). */
	sendOOB(text: string): void {
		this.send(encodeOOB(text));
	}

	/** Runs `handler` for every server command called `name` (`'*'` for all). Returns an unsubscribe function. */
	onCommand(name: string, handler: (command: ServerCommand) => void): () => void {
		return addHandler(this.commandHandlers, name, handler);
	}

	/** Runs `handler` for every connectionless packet whose command is `name` (case-insensitive, `'*'` for all). */
	onOOB(name: string, handler: (message: OOBMessage) => void): () => void {
		return addHandler(this.oobHandlers, name.toLowerCase(), handler);
	}

	configstring(index: number): string {
		return this.configstrings.get(index) ?? '';
	}

	serverInfo(): Record<string, string> {
		return parseInfo(this.configstring(CS_SERVERINFO));
	}

	player(clientNum: number): PlayerInfo | null {
		const raw = this.configstring(CS_PLAYERS + clientNum);
		if (!raw) return null;
		const info = parseInfo(raw);
		return { clientNum, name: info.n ?? '', team: info.t ?? '', info };
	}

	players(): PlayerInfo[] {
		const out: PlayerInfo[] = [];
		for (let i = 0; i < MAX_CLIENTS; i++) {
			const p = this.player(i);
			if (p) out.push(p);
		}
		return out;
	}

	// ---- connection state ---------------------------------------------------------------------

	private resetConnection(): void {
		this.netchan = null;
		this.clientNum = -1;
		this.serverId = 0;
		this.checksumFeed = 0;
		this.configstrings.clear();
		this.reliableSequence = this.reliableAcknowledge = 0;
		this.reliableCommands.fill('');
		this.serverCommands.fill('');
		this.serverCommandSequence = this.lastExecutedServerCommand = this.serverMessageSequence = 0;
		this.snapServerTime = this.serverTimeDelta = this.oldServerTime = 0;
		this.outbox.length = 0;
		this.nextCommandTime = 0;
		this.lastPacketSentTime = -99999;
	}

	private setState(state: ClientState): void {
		if (state === this.state) return;
		const previous = this.state;
		this.state = state;
		this.emit('state', state, previous);
	}

	private shutdown(reason: string): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		const socket = this.socket;
		this.socket = null;
		const closed = new Promise<void>((resolve) => {
			if (!socket) return resolve();
			// dgram sends complete asynchronously; closing early would drop the final disconnect packets
			const closeWhenFlushed = () => (this.inflight > 0 ? setTimeout(closeWhenFlushed, 5) : socket.close(resolve));
			closeWhenFlushed();
		});
		this.netchan = null;
		this.setState('disconnected');
		const pending = this.pending;
		this.pending = null;
		pending?.reject(new Error(reason));
		this.emit('disconnect', reason);
		return closed;
	}

	private fail(error: Error): void {
		this.options.log?.(`error: ${error.message}`);
		if (this.listenerCount('error') > 0) this.emit('error', error);
		this.shutdown(error.message);
	}

	// ---- periodic work (CL_CheckForResend / CL_SendCmd / CL_CheckTimeout) -------------------------

	private tick(): void {
		const t = now();
		try {
			if (this.state === 'connecting' || this.state === 'challenging') {
				if (t - this.connectStart > this.options.connectTimeout) {
					return this.fail(new Error('connection timed out'));
				}
				this.checkForResend(t);
			} else if (this.netchan) {
				this.pumpOutbox(t);
				const interval = this.state === 'connected' ? 1000 : this.options.sendInterval;
				if (t - this.lastPacketSentTime >= interval) this.writePacket();
				if (t - this.lastPacketTime > this.options.timeout) {
					return this.fail(new Error('server connection timed out'));
				}
			}
		} catch (e) {
			this.fail(e as Error);
		}
	}

	private checkForResend(t: number): void {
		if (t - this.connectTime < RETRANSMIT_TIMEOUT) return;
		this.connectTime = t;
		if (this.state === 'connecting') {
			this.sendOOB('getchallenge');
			return;
		}
		const userinfo = buildInfo({
			name: this.options.name ?? 'ETBot',
			rate: 5000,
			snaps: 10,
			cl_anonymous: 0,
			cl_punkbuster: 0,
			cg_predictItems: 1,
			cg_autoactivate: 1,
			cg_autoReload: 1,
			cg_uinfo: '0 0 30',
			cl_guid: this.guid,
			...this.options.userinfo,
			protocol: PROTOCOL_VERSION,
			qport: this.qport,
			challenge: this.challenge,
		});
		this.send(encodeConnectPacket(userinfo));
	}

	// ---- incoming packets -------------------------------------------------------------------------

	private onPacket(packet: Buffer): void {
		try {
			if (isOOB(packet)) {
				this.onOOBPacket(packet);
				return;
			}
			this.lastPacketTime = now();
			if (!this.netchan || packet.length < 4) return;

			const msg = this.netchan.process(packet);
			if (!msg) return;
			decodeServerMessage(msg, this.challenge, this.reliableCommands);
			this.serverMessageSequence = msg.readInt32LE(0);
			this.lastPacketTime = now();
			this.parseServerMessage(msg);
		} catch (e) {
			this.fail(e as Error);
		}
	}

	private onOOBPacket(packet: Buffer): void {
		const m = decodeOOB(packet);
		if (!m) return;
		const cmd = m.command.toLowerCase();

		switch (cmd) {
			case 'challengeresponse':
				if (this.state === 'connecting') {
					this.challenge = atoi(m.args[0]);
					this.setState('challenging');
					this.connectTime = -99999;
				}
				break;
			case 'connectresponse':
				if (this.state === 'challenging') {
					this.netchan = new Netchan(this.qport);
					this.setState('connected');
					this.lastPacketSentTime = -99999;
					this.tick();
				}
				break;
			case 'print':
				if (this.state === 'connecting' || this.state === 'challenging') {
					const text = m.data;
					if (text.startsWith('[err_dialog]') || text.startsWith('[err_prot]')) {
						this.emit('oob', m);
						this.fail(new Error(text.replace(/^\[err_(dialog|prot)\]/, '').trim()));
						return;
					}
				}
				break;
			case 'disconnect':
				if (this.netchan && now() - this.lastPacketTime >= 3000) {
					this.fail(new Error('Server disconnected for unknown reason'));
					return;
				}
				break;
			case 'echo':
				this.sendOOB(m.args[0] ?? '');
				break;
		}

		this.emit('oob', m);
		dispatch(this.oobHandlers.get(cmd), m);
		dispatch(this.oobHandlers.get('*'), m);
	}

	// ---- server message parsing (cl_parse.c) -----------------------------------------------------

	private parseServerMessage(msg: Buffer): void {
		const r = new MsgReader(msg, 32);
		this.reliableAcknowledge = r.readLong();
		if (this.reliableAcknowledge < this.reliableSequence - MAX_RELIABLE_COMMANDS) {
			this.reliableAcknowledge = this.reliableSequence;
		}

		let gotSnapshot = false;
		for (;;) {
			if (r.overflowed) throw new Error('read past end of server message');
			const cmd = r.readByte();
			if (cmd === svc.EOF) break;

			if (cmd === svc.nop) continue;
			if (cmd === svc.serverCommand) {
				this.parseCommandString(r);
			} else if (cmd === svc.gamestate) {
				this.parseGamestate(r);
			} else if (cmd === svc.snapshot) {
				this.parseSnapshotHeader(r);
				gotSnapshot = true;
				break; // player/entity payload follows; not needed
			} else {
				throw new Error(`illegible server message ${cmd}`);
			}
		}

		if (gotSnapshot && (this.state === 'primed' || this.state === 'active')) this.runServerCommands();
	}

	private parseCommandString(r: MsgReader): void {
		const seq = r.readLong();
		const s = r.readString();
		if (this.serverCommandSequence >= seq) return;
		this.serverCommandSequence = seq;
		this.serverCommands[seq & (MAX_RELIABLE_COMMANDS - 1)] = s;
	}

	private parseGamestate(r: MsgReader): void {
		this.configstrings.clear();
		this.serverCommandSequence = r.readLong();

		for (;;) {
			const cmd = r.readByte();
			if (cmd === svc.EOF) break;
			if (cmd === svc.configstring) {
				const i = r.readShort();
				if (i < 0 || i >= MAX_CONFIGSTRINGS) throw new Error('configstring > MAX_CONFIGSTRINGS');
				const s = r.readBigString();
				if (s) this.configstrings.set(i, s);
			} else if (cmd === svc.baseline) {
				r.readBits(MAX_GENTITIES_BITS);
				skipDeltaEntity(r);
			} else {
				throw new Error('CL_ParseGamestate: bad command byte');
			}
			if (r.overflowed) throw new Error('gamestate truncated');
		}

		this.clientNum = r.readLong();
		this.checksumFeed = r.readLong();
		this.serverId = atoi(infoValue(this.configstring(CS_SYSTEMINFO), 'sv_serverid'));

		this.setState('primed');
		this.emit('gamestate', { clientNum: this.clientNum, serverId: this.serverId, checksumFeed: this.checksumFeed });
		this.sendPureChecksums();
		for (let i = 0; i < 3; i++) this.writePacket();
	}

	private parseSnapshotHeader(r: MsgReader): void {
		const serverTime = r.readLong();
		r.readByte(); // deltaNum
		const snapFlags = r.readByte();
		const areaLen = r.readByte();
		if (areaLen > 32) throw new Error(`invalid size ${areaLen} for areamask`);
		for (let i = 0; i < areaLen; i++) r.readByte();

		this.snapServerTime = serverTime;
		const t = now();
		if (this.state === 'primed') {
			if (snapFlags & SNAPFLAG_NOT_ACTIVE) return;
			this.serverTimeDelta = serverTime - t;
			this.oldServerTime = serverTime;
			this.setState('active');
			const pending = this.pending;
			this.pending = null;
			pending?.resolve();
			this.emit('active');
			return;
		}
		this.adjustTimeDelta(serverTime, t);
	}

	private adjustTimeDelta(serverTime: number, t: number): void {
		const newDelta = serverTime - t;
		const deltaDelta = Math.abs(newDelta - this.serverTimeDelta);
		if (deltaDelta > 500) {
			this.serverTimeDelta = newDelta;
			this.oldServerTime = serverTime;
		} else if (deltaDelta > 100) {
			this.serverTimeDelta = (this.serverTimeDelta + newDelta) >> 1;
		} else if (this.extrapolatedSnapshot) {
			this.extrapolatedSnapshot = false;
			this.serverTimeDelta -= 2;
		} else {
			this.serverTimeDelta++;
		}
	}

	/** Estimated current server time (the serverTime of our keepalive usercmds). */
	private serverTime(): number {
		if (this.state !== 'active') return 0;
		const st = Math.max(now() + this.serverTimeDelta, this.oldServerTime);
		this.extrapolatedSnapshot = now() + this.serverTimeDelta >= this.snapServerTime - 5;
		this.oldServerTime = st;
		return st;
	}

	// ---- server commands (CL_GetServerCommand + cgame dispatch) ---------------------------------

	private runServerCommands(): void {
		while (this.lastExecutedServerCommand < this.serverCommandSequence) {
			const seq = ++this.lastExecutedServerCommand;
			if (seq <= this.serverCommandSequence - MAX_RELIABLE_COMMANDS) {
				throw new Error('a reliable command was cycled out');
			}
			this.executeServerCommand(seq, this.serverCommands[seq & (MAX_RELIABLE_COMMANDS - 1)]);
			if (this.state === 'disconnected') return;
		}
	}

	private executeServerCommand(seq: number, raw: string): void {
		const tokens = tokenize(raw);
		const name = tokens[0] ?? '';
		const args = tokens.slice(1);

		switch (name) {
			case 'disconnect':
				this.shutdown(args[0] ? `Server Disconnected - ${args[0]}` : 'Server disconnected');
				return;
			case 'bcs0':
				this.bigConfigString = `cs ${args[0]} "${args[1] ?? ''}`;
				return;
			case 'bcs1':
				this.bigConfigString += args[1] ?? '';
				return;
			case 'bcs2':
				this.executeServerCommand(seq, `${this.bigConfigString}${args[1] ?? ''}"`);
				return;
			case 'popup':
				return;
			case 'cs':
				this.applyConfigstring(atoi(args[0]), args.slice(1).join(' '));
				break;
		}

		const command: ServerCommand = { seq, raw, name, args };
		this.emit('serverCommand', command);
		dispatch(this.commandHandlers.get(name), command);
		dispatch(this.commandHandlers.get('*'), command);

		if (name === 'chat' || name === 'tchat') {
			const chat = parseChat(name, args);
			if (chat) {
				const known = this.player(chat.clientNum);
				if (known && !chat.sender) chat.sender = known.name;
				this.emit('chat', chat);
			}
		}
	}

	private applyConfigstring(index: number, value: string): void {
		if (index < 0 || index >= MAX_CONFIGSTRINGS) throw new Error('configstring > MAX_CONFIGSTRINGS');
		const previous = this.configstring(index);
		if (previous === value) return;
		if (value) this.configstrings.set(index, value);
		else this.configstrings.delete(index);
		if (index === CS_SYSTEMINFO) this.serverId = atoi(infoValue(value, 'sv_serverid'));
		this.emit('configstring', index, value, previous);
	}

	// ---- outgoing packets (CL_WritePacket) --------------------------------------------------------------

	private addReliableCommand(command: string): void {
		if (this.reliableSequence - this.reliableAcknowledge > MAX_RELIABLE_COMMANDS) {
			throw new Error('Client command overflow');
		}
		this.reliableSequence++;
		this.reliableCommands[this.reliableSequence & (MAX_RELIABLE_COMMANDS - 1)] = command;
	}

	private pureCheckPaths(): string[] {
		const paths = [...(this.options.paks ?? [])];
		const { etDir } = this.options;
		if (etDir) {
			const names = infoValue(this.configstring(CS_SYSTEMINFO), 'sv_pakNames').split(' ').filter(Boolean);
			for (const name of names) {
				const path = join(etDir, `${name}.pk3`);
				if (!paths.includes(path) && existsSync(path)) paths.push(path);
			}
		}
		return paths;
	}

	private sendPureChecksums(): void {
		const paths = this.pureCheckPaths();
		const pure = infoValue(this.configstring(CS_SYSTEMINFO), 'sv_pure');
		if (paths.length === 0) {
			if (pure !== '0') {
				this.emit('pureCheck', []);
				this.options.log?.('server is pure but no pk3 files were found; it will drop us');
			}
			return;
		}
		const paks = paths.map((path) => {
			let pak = this.pakCache.get(path);
			if (!pak) this.pakCache.set(path, (pak = readPak(path)));
			return pak;
		});
		this.emit('pureCheck', paths);
		this.nextCommandTime = now() + this.options.commandInterval;
		this.addReliableCommand(buildPureCommand({ paks, serverId: this.serverId, checksumFeed: this.checksumFeed }));
	}

	private writePacket(): void {
		const netchan = this.netchan;
		if (!netchan) return;

		const w = new MsgWriter();
		w.writeLong(this.serverId);
		w.writeLong(this.serverMessageSequence);
		w.writeLong(this.serverCommandSequence);

		for (let i = this.reliableAcknowledge + 1; i <= this.reliableSequence; i++) {
			w.writeByte(clc.clientCommand);
			w.writeLong(i);
			w.writeString(this.reliableCommands[i & (MAX_RELIABLE_COMMANDS - 1)]);
		}

		if (this.state === 'primed' || this.state === 'active') {
			// One idle usercmd: required so the server moves us from primed to active.
			const serverTime = this.serverTime();
			w.writeByte(clc.moveNoDelta);
			w.writeByte(1);
			writeIdleUsercmd(w, serverTime);
		}
		w.writeByte(clc.EOF);

		encodeClientMessage(w.data, w.cursize, this.challenge, this.serverCommands);
		for (const p of netchan.transmit(w.data.subarray(0, w.cursize))) this.send(p);
		this.lastPacketSentTime = now();
	}

	private send(packet: Buffer): void {
		const socket = this.socket;
		if (!socket) return;
		this.inflight++;
		socket.send(packet, this.options.port, this.serverAddress, () => this.inflight--);
	}
}

/** MSG_WriteDeltaUsercmdKey for a command that only differs from the null command by serverTime. */
function writeIdleUsercmd(w: MsgWriter, serverTime: number): void {
	if (serverTime < 256) {
		w.writeBits(1, 1);
		w.writeBits(serverTime, 8);
	} else {
		w.writeBits(0, 1);
		w.writeBits(serverTime, 32);
	}
	w.writeBits(0, 1); // no other field changed
}

/** Reads and discards a baseline entity delta (MSG_ReadDeltaEntity from a null state). */
function skipDeltaEntity(r: MsgReader): void {
	if (r.readBits(1) === 1) return; // removed
	if (r.readBits(1) === 0) return; // no delta
	const lc = Math.min(r.readByte(), ENTITY_FIELD_BITS.length);
	for (let i = 0; i < lc; i++) {
		if (!r.readBits(1)) continue;
		const bits = ENTITY_FIELD_BITS[i];
		if (bits === 0) {
			if (r.readBits(1) === 0) continue;
			r.readBits(r.readBits(1) === 0 ? 13 : 32);
		} else if (r.readBits(1)) {
			r.readBits(bits);
		}
	}
}

function sanitize(text: string): string {
	return text.replace(/["\r\n]/g, (c) => (c === '"' ? "'" : ' '));
}

function addHandler<T>(map: Map<string, Set<(v: T) => void>>, name: string, handler: (v: T) => void): () => void {
	let set = map.get(name);
	if (!set) map.set(name, (set = new Set()));
	set.add(handler);
	return () => void set.delete(handler);
}

function dispatch<T>(handlers: Set<(v: T) => void> | undefined, value: T): void {
	if (!handlers) return;
	for (const h of [...handlers]) h(value);
}

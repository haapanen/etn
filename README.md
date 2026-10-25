# etn

`etn` is a Node.js/TypeScript UDP client library for Wolfenstein: Enemy Territory
(protocol 84), plus an interactive chat CLI. It is intended for building bots
and tools that connect to Enemy Territory servers, read server state, and send
commands or chat messages.

The client focuses on connection handling, configstrings, server commands, and
chat. It does not expose entity snapshots or implement player movement.

## Requirements

- Node.js 18 or newer
- TypeScript is included as a development dependency if you build from source

## Install and build

```sh
npm install
npm run build
```

The build writes JavaScript and declaration files to `dist/`. The package entry
point is `dist/index.js`, and the `etn-chat` executable is `dist/cli.js`.

For development, run `npm test` to execute the test suite and `npm run typecheck`
to type-check the source without emitting files.

## Library

Import the client and helpers from the package entry point:

```ts
import { ETClient, stripColors } from 'etn';

const client = new ETClient({
  host: '127.0.0.1',
  name: 'ExampleBot',
});

client.on('chat', (message) => {
  console.log(`${stripColors(message.sender)}: ${stripColors(message.message)}`);
  if (message.message.trim() === '!ping') client.say('pong');
});

client.on('disconnect', (reason) => console.log('disconnected:', reason));

await client.connect();
console.log(`Connected as client ${client.clientNum}`);

// When your application is shutting down:
await client.disconnect();
```

`connect()` resolves when the server has put the client in the game. It accepts
an optional `AbortSignal`:

```ts
const controller = new AbortController();
await client.connect({ signal: controller.signal });
```

### Client options

`ETClient` requires `host`. Other options include:

| Option | Default | Description |
| --- | --- | --- |
| `port` | `27960` | Server UDP port |
| `name` | — | Player name |
| `userinfo` | — | Extra or overriding userinfo cvars |
| `qport` | random | Client qport |
| `sendInterval` | `100` ms | Keepalive packet interval |
| `connectTimeout` | `20000` ms | Maximum time to connect |
| `timeout` | `200000` ms | Disconnect after this long without a server packet |
| `commandInterval` | `850` ms | Minimum time between ordinary client commands; `0` disables pacing |
| `paks` | `[]` | PK3 paths used to answer a pure-server check |
| `etDir` | — | ET install directory used to find server-listed PK3s |
| `log` | — | Callback for protocol and diagnostic log messages |

### Client API

- `connect({ signal? })` connects to the server; `disconnect(reason?)` leaves and
  closes the connection.
- `say(text)`, `sayTeam(text)`, and `sayFireteam(text)` send public, team, and
  fireteam chat. The client paces ordinary commands to respect server flood
  protection.
- `sendCommand(command)` sends a reliable client command, such as
  `team allies`; `sendOOB(text)` sends a connectionless packet.
- `players()`, `player(clientNum)`, `serverInfo()`, and `configstring(index)`
  read the current player list, individual player data, server info, and
  configstrings.
- `onCommand(name, handler)` registers for a named server command; use `'*'` to
  observe all commands. It returns an unsubscribe function.
- `onOOB(name, handler)` registers for a connectionless server message (command
  matching is case-insensitive).

The client also emits EventEmitter events:

| Event | Data |
| --- | --- |
| `state` | New and previous connection state |
| `gamestate` | Client number, server ID, and checksum feed |
| `active` | Client has entered the game |
| `chat` | Parsed public, team, or fireteam message |
| `serverCommand` | Parsed reliable server command |
| `configstring` | Index, new value, and previous value |
| `pureCheck` | PK3 paths being used for the server's pure check |
| `oob` | Decoded connectionless packet |
| `disconnect` | Disconnect reason |
| `error` | Socket error (only emitted when an `error` listener is registered) |

Chat message objects include `type`, `team`, `sender`, `location`, `clientNum`,
`message`, and `raw`. Names and message text may include Enemy Territory color
codes; use `stripColors()` to remove them.

### One-shot server queries

`getInfo`, `getStatus`, and `rcon` send connectionless queries without joining
the server. Each accepts `QueryOptions` with optional `port` (default `27960`)
and `timeout` in milliseconds (default `2000`).

```ts
import { getInfo, getStatus, rcon } from 'etn';

const info = await getInfo('127.0.0.1');
console.log(info.mapname, info.hostname);

const status = await getStatus('127.0.0.1');
console.log(status.players);

// Keep the RCON password private; do not hard-code or log it.
const response = await rcon('127.0.0.1', process.env.RCON_PASSWORD!, 'status');
console.log(response);
```

`getInfo()` returns the server info as a key/value record. `getStatus()` returns
`{ info, players }`, where each player has `score`, `ping`, and `name`. `rcon()`
returns the concatenated server print output. The server rate-limits RCON
commands.

### Other exports

The package also exports protocol and parsing utilities for applications that
need lower-level access:

- Out-of-band packet helpers: `decodeOOB`, `encodeOOB`,
  `encodeConnectPacket`, and `isOOB`
- Info-string, tokenizing, and chat helpers: `parseInfo`, `infoValue`,
  `buildInfo`, `tokenize`, `parseChat`, and `stripColors`
- Pure-server helpers: `readPak`, `pakPureChecksum`, and `buildPureCommand`
- Message and channel primitives: `MsgReader`, `MsgWriter`, and `Netchan`
- `PROTOCOL_VERSION` and `CS_PLAYERS` constants

## Chat CLI

When working from the repository, start the CLI with:

```sh
npm run chat -- 127.0.0.1
```

After building or installing the package, use the `etn-chat` executable:

```sh
etn-chat 127.0.0.1
```

The address can include a port (`example.org:27961`) or the port can be passed
separately:

```sh
etn-chat example.org --port 27961 --name ChatBot --team allies
```

### CLI options

| Option | Description |
| --- | --- |
| `--name <name>` | Player name (default `ETBot`) |
| `--team <team>` | Join `axis`, `allies`, or `spectator` after connecting |
| `--port <port>` | Server port (default `27960`; a port in the address takes precedence unless this option is supplied) |
| `--et-dir <dir>` | ET install directory for server-listed pure-server PK3s; can also be set with `ET_DIR` |
| `--paks <a,b,...>` | Comma-separated PK3 paths for pure servers; can also be set with `ET_PAKS` |
| `--no-color` | Disable ANSI colors |
| `--debug` | Print server commands and protocol log lines |
| `-h`, `--help` | Show usage |

For a pure server, the client's PK3 files must match the server's content and
include the PK3 containing the server's cgame and UI modules. Set `--et-dir` or
provide `--paks` as appropriate. A pure check is not needed when the server has
`sv_pure 0`.

### Chat commands

Plain text is sent to the currently selected channel (public by default).

| Command | Action |
| --- | --- |
| `/say <text>` | Send public chat |
| `/t <text>` | Send team chat (requires being on a team) |
| `/f <text>` | Send fireteam chat (requires being in a fireteam) |
| `/mode all\|team\|fireteam` | Select the channel for plain text |
| `/team axis\|allies\|spectator` | Change team |
| `/fireteam <args>` | Send a fireteam command, e.g. `/fireteam create` or `/fireteam invite 3` |
| `/players` | List players |
| `/raw <command>` | Send a client command |
| `/help` | Show CLI help |
| `/quit` | Disconnect and exit |

The CLI prints received server messages and disconnects cleanly when you quit
or press Ctrl+C.

## Example bot

`examples/chatbot.ts` demonstrates connecting, handling chat and server
commands, and responding to simple messages. Run it with:

```sh
ET_HOST=127.0.0.1 npm run example
```

Optional environment variables are `ET_PORT`, `ET_NAME`, `ET_DIR`, `ET_PAKS`,
and `ET_DEBUG`. For example:

```sh
ET_HOST=example.org ET_PORT=27960 ET_NAME=ChatBot ET_DEBUG=1 npm run example
```

## License

MIT. See [package.json](./package.json).

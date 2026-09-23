import type { PluginAPI } from '@ampcode/plugin'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

export const description =
	'Collects a single-line secret through owner-only input and stores it in Amp secrets without returning its value in the tool result.'

type Scope = 'user' | 'workspace' | 'project' | 'app'
type Result = { kind: 'exit'; code: number } | { kind: 'timeout' } | { kind: 'start-error' } | { kind: 'interrupted' }

export interface ExecutionState {
	disposed: boolean
	active: Set<ChildProcess>
	pending: Map<ChildProcess, ReturnType<typeof setTimeout>>
}

export function secretRequest(input: Record<string, unknown>): {
	name: string
	scope: Scope
	target?: string
	args: string[]
} {
	const name = input.name
	const scope = input.scope
	const target = input.target
	if (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) || /[\r\n\u2028\u2029]/u.test(name)) {
		throw new Error('Secret name must be 1–128 uppercase letters, digits, or underscores, starting with a letter or underscore.')
	}
	if (scope !== 'user' && scope !== 'workspace' && scope !== 'project' && scope !== 'app') {
		throw new Error('Scope must be user, workspace, project, or app.')
	}
	if (scope === 'project' || scope === 'app') {
		if (typeof target !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target) || /[\r\n\u2028\u2029]/u.test(target)) {
			throw new Error('Project or app target must be an explicit namespace/name.')
		}
	} else if (target !== undefined) {
		throw new Error('User and workspace scopes must not specify a target.')
	}

	const destination = scope === 'project' || scope === 'app' ? [`--${scope}`, target as string] : [`--${scope}`]
	return { name, scope, target: target as string | undefined, args: ['secrets', 'set', ...destination, '--secret', '--data-file', '-', name] }
}

export function secretEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {}
	for (const key of ['PATH', 'HOME', 'AMP_API_KEY', 'AMP_URL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
		if (process.env[key] !== undefined) env[key] = process.env[key]
	}
	return env
}

function stopGroup(child: ChildProcess, signal: NodeJS.Signals) {
	if (!child.pid) return
	try {
		if (process.platform === 'win32') child.kill(signal)
		else process.kill(-child.pid, signal)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
	}
}

export function runSecretCommand(
	binary: string,
	args: string[],
	secret: string,
	cwd: string,
	timeoutMs: number,
	state: ExecutionState,
): Promise<Result> {
	return new Promise((resolve) => {
		if (state.disposed) {
			resolve({ kind: 'interrupted' })
			return
		}
		let child: ChildProcess
		try {
			child = spawn(binary, args, {
				cwd,
				env: secretEnvironment(),
				stdio: ['pipe', 'ignore', 'ignore'],
				detached: process.platform !== 'win32',
			})
		} catch {
			resolve({ kind: 'start-error' })
			return
		}

		state.active.add(child)
		let timedOut = false
		let writeFailed = false
		let settled = false
		const finish = (result: Result) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			state.active.delete(child)
			resolve(result)
		}
		const timer = setTimeout(() => {
			timedOut = true
			stopGroup(child, 'SIGTERM')
			// Keep this timer even if the parent exits: descendants may ignore SIGTERM.
			const forceKill = setTimeout(() => {
				stopGroup(child, 'SIGKILL')
				state.pending.delete(child)
			}, 2_000)
			state.pending.set(child, forceKill)
		}, timeoutMs)
		child.once('error', () => finish({ kind: 'start-error' }))
		child.once('close', (code) => {
			finish(state.disposed ? { kind: 'interrupted' } : timedOut ? { kind: 'timeout' } : { kind: 'exit', code: writeFailed ? 1 : (code ?? 1) })
		})
		child.stdin?.on('error', () => { writeFailed = true })
		child.stdin?.end(secret, 'utf8')
	})
}

export default function (amp: PluginAPI) {
	const state: ExecutionState = { disposed: false, active: new Set(), pending: new Map() }
	amp.registerTool({
		name: 'collect_secret',
		title: 'Store Amp secret',
		description:
			'Use when the user needs to store a single-line credential as an Amp secret. Provide a validated uppercase environment-variable name, a scope (user, workspace, project, or app), and for project/app the explicit namespace/name target. The human reviews the requested destination and Amp account, then enters the value in an owner-only secret dialog. Never include the value in tool arguments. Stored secrets may be injected into future agent environments. This tool cannot run arbitrary commands or store multiline private keys.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Uppercase secret name, e.g. EXAMPLE_API_KEY.' },
				scope: { type: 'string', enum: ['user', 'workspace', 'project', 'app'] },
				target: { type: 'string', description: 'Required for project or app: explicit namespace/name. Otherwise omit.' },
			},
			required: ['name', 'scope'],
			additionalProperties: false,
		},
		async execute(input, ctx) {
			let request: ReturnType<typeof secretRequest>
			try {
				request = secretRequest(input)
			} catch (error) {
				return (error as Error).message
			}
			if (state.disposed) return 'Plugin unloaded. No secret was requested or stored.'
			const user = amp.system.user
			if (!user) return 'Amp account identity unavailable. No secret was requested or stored.'
			if (request.scope === 'workspace' && !user.workspace) {
				return 'No connected Amp workspace. No secret was requested or stored.'
			}
			if (process.env.AMP_USER_ID && process.env.AMP_USER_ID !== user.id) {
				return 'Amp account identity differs from this executor. No secret was requested or stored.'
			}
			if (process.env.AMP_URL) {
				try {
					if (new URL(process.env.AMP_URL).origin !== amp.system.ampURL.origin) {
						return 'Amp CLI endpoint differs from this connection. No secret was requested or stored.'
					}
				} catch {
					return 'Amp CLI endpoint is invalid. No secret was requested or stored.'
				}
			}
			const destination = `${request.scope}${request.target ? ` (${request.target})` : ''}`
			const identity = `Connected Amp account: ${user.username ? `@${user.username}` : user.email}; workspace: ${user.workspace?.name ?? 'none'}; server: ${amp.system.ampURL.origin}.`
			const reach: Record<Scope, string> = {
				user: 'Personal secrets can override workspace and project values in your orbs and runners.',
				workspace: 'Workspace secrets are available to eligible workspace orbs, apps, and runners.',
				project: 'Project secrets are available to eligible project orbs and runners.',
				app: 'App secrets take effect in that app on its next deployment.',
			}

			let approved: boolean
			try {
				approved = await ctx.ui.confirm({
					title: 'Store Amp secret?',
					message: `Store **${request.name}** in **${destination}** secrets?\n\n${identity}\n\n${reach[request.scope]}\n\nCommand: \`amp ${request.args.join(' ')}\`\n\nThis adds or replaces the secret at that destination. The CLI uses this executor's credentials; this plugin cannot verify that they belong to the connected account shown above.`,
					confirmButtonText: 'Continue to secret input',
					requireHuman: true,
				})
			} catch {
				return 'Confirmation UI unavailable. No secret was requested or stored.'
			}
			if (state.disposed) return 'Plugin unloaded. No secret was requested or stored.'
			if (!approved) return 'Cancelled. No secret was requested or stored.'

			let secret: string | undefined
			try {
				secret = await ctx.ui.input({
					title: `Secret value for ${request.name}`,
					helpText: `Store a single-line value in ${destination} secrets. ${identity} ${reach[request.scope]} The value will not be returned in the tool result.`,
					fieldName: request.name,
					secret: true,
					requireHuman: true,
				})
			} catch {
				return 'Secret input unavailable. No secret was stored.'
			}
			if (state.disposed) return 'Plugin unloaded. No secret was stored.'
			if (secret === undefined) return 'Cancelled. No secret was stored.'
			if (!secret || /[\r\n]/.test(secret) || Buffer.byteLength(secret, 'utf8') > 1024 * 1024) {
				return 'Secret must be nonempty, single-line, and at most 1 MiB. No secret was stored.'
			}

			const cwd = amp.system.workspaceRoot
				? amp.helpers.filePathFromURI(amp.system.workspaceRoot)
				: process.cwd()
			const binary = process.env.AMP_BIN_DIR ? join(process.env.AMP_BIN_DIR, 'amp') : 'amp'
			const result = await runSecretCommand(binary, request.args, secret, cwd, 60_000, state)
			if (result.kind === 'timeout') return 'Amp secrets set timed out. Check the destination before retrying; the write may have completed.'
			if (result.kind === 'interrupted') return 'Plugin unloaded before completion. Check the destination before retrying; the write may have completed.'
			if (result.kind === 'start-error') return 'Amp CLI could not start. No command output was returned.'
			return result.code === 0
				? `Stored ${request.name} as an Amp ${request.scope} secret${request.target ? ` (${request.target})` : ''}.`
				: `Amp secrets set exited with status ${result.code}. Check the destination before retrying; output was discarded.`
		},
	})

	amp.onDispose(async () => {
		state.disposed = true
		const children = [...new Set([...state.active, ...state.pending.keys()])]
		for (const child of children) stopGroup(child, 'SIGTERM')
		if (children.length) await new Promise((resolve) => setTimeout(resolve, 500))
		for (const child of children) stopGroup(child, 'SIGKILL')
		for (const timer of state.pending.values()) clearTimeout(timer)
		state.pending.clear()
	})
}

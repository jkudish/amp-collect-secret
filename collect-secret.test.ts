import { afterEach, describe, expect, test } from 'bun:test'
import type { PluginAPI, PluginToolDefinition, PluginUI } from '@ampcode/plugin'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import collectSecret, { runSecretCommand, secretEnvironment, secretRequest, type ExecutionState } from './collect-secret'

const roots: string[] = []
const originalBinaryDir = process.env.AMP_BIN_DIR

function temporaryRoot() {
	const root = mkdtempSync(join(tmpdir(), 'collect-secret-'))
	roots.push(root)
	return root
}

function fakeAmp(root: string, source: string) {
	const binary = join(root, 'amp')
	writeFileSync(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 })
	chmodSync(binary, 0o700)
	process.env.AMP_BIN_DIR = root
	return binary
}

async function waitForFile(path: string) {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (existsSync(path)) return
		await Bun.sleep(20)
	}
	throw new Error('mock command did not start')
}

function toolWithUI(ui: Partial<PluginUI>) {
	let tool: PluginToolDefinition | undefined
	let dispose: (() => void | Promise<void>) | undefined
	const amp = {
		system: {
			workspaceRoot: null,
			ampURL: new URL(process.env.AMP_URL ?? 'https://ampcode.com'),
			user: {
				id: process.env.AMP_USER_ID ?? 'user-test',
				username: 'test-user',
				email: 'test@example.invalid',
				workspace: { id: 'workspace-test', name: 'example-team' },
			},
		},
		registerTool: (definition: PluginToolDefinition) => { tool = definition },
		onDispose: (callback: () => void | Promise<void>) => { dispose = callback },
	} as unknown as PluginAPI
	collectSecret(amp)
	return {
		execute: (input: Record<string, unknown>) => tool!.execute(input, { ui } as never),
		dispose: () => dispose!(),
		amp,
	}
}

function executionState(): ExecutionState {
	return { disposed: false, active: new Set(), pending: new Map() }
}

afterEach(() => {
	if (originalBinaryDir === undefined) delete process.env.AMP_BIN_DIR
	else process.env.AMP_BIN_DIR = originalBinaryDir
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('request boundary', () => {
	test('builds only Amp secrets set arguments for explicit destinations', () => {
		expect(secretRequest({ name: 'API_KEY', scope: 'user' }).args).toEqual([
			'secrets', 'set', '--user', '--secret', '--data-file', '-', 'API_KEY',
		])
		expect(secretRequest({ name: 'API_KEY', scope: 'workspace' }).args[2]).toBe('--workspace')
		expect(secretRequest({ name: 'API_KEY', scope: 'project', target: 'jkudish/my-project' }).args).toEqual([
			'secrets', 'set', '--project', 'jkudish/my-project', '--secret', '--data-file', '-', 'API_KEY',
		])
		expect(secretRequest({ name: 'API_KEY', scope: 'app', target: 'team/my-app' }).args).toEqual([
			'secrets', 'set', '--app', 'team/my-app', '--secret', '--data-file', '-', 'API_KEY',
		])
	})

	test('rejects malformed names, missing targets, and argument-shaped targets before showing UI', () => {
		for (const input of [
			{ name: 'API_KEY; curl attacker', scope: 'user' },
			{ name: 'api_key', scope: 'user' },
			{ name: 'API_KEY', scope: 'project' },
			{ name: 'API_KEY', scope: 'project', target: '--user' },
			{ name: 'API_KEY', scope: 'app', target: 'team/app/extra' },
			{ name: 'API_KEY', scope: 'workspace', target: 'team/app' },
			...['\n', '\r', '\u2028', '\u2029'].flatMap((ending) => [
				{ name: `API_KEY${ending}`, scope: 'user' },
				{ name: 'API_KEY', scope: 'project', target: `jkudish/project${ending}` },
			]),
		]) {
			expect(() => secretRequest(input)).toThrow()
		}
	})

	test('child environment does not inherit unrelated credentials', () => {
		const previous = process.env.UNRELATED_CREDENTIAL
		process.env.UNRELATED_CREDENTIAL = 'not-for-child'
		try {
			expect(secretEnvironment().UNRELATED_CREDENTIAL).toBeUndefined()
			expect(Object.keys(secretEnvironment()).sort()).toEqual(
			['PATH', 'HOME', 'AMP_API_KEY', 'AMP_URL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
				.filter((key) => process.env[key] !== undefined).sort(),
			)
		} finally {
			if (previous === undefined) delete process.env.UNRELATED_CREDENTIAL
			else process.env.UNRELATED_CREDENTIAL = previous
		}
	})
})

describe('tool behavior', () => {
	test('cancellation and UI failures never start a command', async () => {
		const root = temporaryRoot()
		const marker = join(root, 'ran')
		fakeAmp(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`)
		let prompts = 0
		const cancelled = toolWithUI({
			confirm: async () => { prompts++; return false },
			input: async () => { throw new Error('should not ask for a secret') },
		})
		expect(await cancelled.execute({ name: 'API_KEY', scope: 'user' })).toContain('Cancelled')
		expect(await cancelled.execute({ name: 'API_KEY', scope: 'project', target: '../escape' })).toContain('namespace/name')
		expect(prompts).toBe(1)
		expect(existsSync(marker)).toBe(false)

		const missing = toolWithUI({ confirm: async () => true, input: async () => undefined })
		expect(await missing.execute({ name: 'API_KEY', scope: 'user' })).toContain('Cancelled')
		const unavailable = toolWithUI({ confirm: async () => { throw new Error('UI unavailable') } })
		expect(await unavailable.execute({ name: 'API_KEY', scope: 'user' })).toContain('unavailable')
		expect(existsSync(marker)).toBe(false)
	})

	test('uses owner-only secret input and sends only its bytes on stdin', async () => {
		const root = temporaryRoot()
		const report = join(root, 'report.json')
		fakeAmp(root, `
let value = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (part) => { value += part })
process.stdin.on('end', () => {
  require('node:fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({
    args: process.argv.slice(2), value, inherited: process.env.UNRELATED_CREDENTIAL ?? null,
  }))
})
`)
		const secret = 'fake-test-value!'
		let confirmation: unknown
		let inputOptions: unknown
		const tool = toolWithUI({
			confirm: async (options) => { confirmation = options; return true },
			input: async (options) => { inputOptions = options; return secret },
		})
		const result = await tool.execute({ name: 'API_KEY', scope: 'project', target: 'jkudish/my-project' })
		expect(result).toContain('Stored API_KEY')
		expect(result).not.toContain(secret)
		expect(confirmation).toMatchObject({ requireHuman: true })
		expect(JSON.stringify(confirmation)).toContain('jkudish/my-project')
		expect(JSON.stringify(confirmation)).toContain('@test-user')
		expect(JSON.stringify(confirmation)).toContain('example-team')
		expect(JSON.stringify(confirmation)).toContain('ampcode.com')
		expect(inputOptions).toMatchObject({ secret: true, requireHuman: true, fieldName: 'API_KEY' })
		expect(JSON.stringify(inputOptions)).toContain('jkudish/my-project')
		expect(JSON.stringify(inputOptions)).not.toContain(secret)
		expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({
			args: ['secrets', 'set', '--project', 'jkudish/my-project', '--secret', '--data-file', '-', 'API_KEY'],
			value: secret,
			inherited: null,
		})
	})

	test('rejects multiline or empty values before invoking the CLI', async () => {
		const root = temporaryRoot()
		const marker = join(root, 'ran')
		fakeAmp(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`)
		for (const value of ['', 'line one\nline two', 'line one\rline two']) {
			const tool = toolWithUI({ confirm: async () => true, input: async () => value })
			expect(await tool.execute({ name: 'API_KEY', scope: 'user' })).toContain('single-line')
		}
		expect(existsSync(marker)).toBe(false)
	})

	test('does not relay CLI output or claim a failed write succeeded', async () => {
		const root = temporaryRoot()
		fakeAmp(root, `
process.stdin.resume()
process.stdout.write('fake-test-value!')
process.stderr.write('fake-test-value!')
process.exitCode = 7
`)
		const tool = toolWithUI({ confirm: async () => true, input: async () => 'fake-test-value!' })
		const result = await tool.execute({ name: 'API_KEY', scope: 'workspace' })
		expect(result).toContain('status 7')
		expect(result).not.toContain('fake-test-value!')
	})

	test('rejects a mismatched executor identity or endpoint before prompting', async () => {
		let prompts = 0
		const tool = toolWithUI({ confirm: async () => { prompts++; return true } })
		const previousURL = process.env.AMP_URL
		process.env.AMP_URL = 'https://ampcode.com'
		;(tool.amp.system as { ampURL: URL }).ampURL = new URL('https://ampcode.com')
		;(tool.amp.system as { user: unknown }).user = null
		expect(await tool.execute({ name: 'API_KEY', scope: 'user' })).toContain('identity unavailable')
		;(tool.amp.system as { user: unknown }).user = {
			id: process.env.AMP_USER_ID ?? 'user-test', username: 'test-user', email: 'test@example.invalid', workspace: null,
		}
		expect(await tool.execute({ name: 'API_KEY', scope: 'workspace' })).toContain('No connected Amp workspace')
		;(tool.amp.system as { user: unknown }).user = {
			id: 'other-user', username: 'test-user', email: 'test@example.invalid', workspace: null,
		}
		const previousUserID = process.env.AMP_USER_ID
		process.env.AMP_USER_ID = 'expected-user'
		try {
			expect(await tool.execute({ name: 'API_KEY', scope: 'user' })).toContain('identity differs')
		} finally {
			if (previousUserID === undefined) delete process.env.AMP_USER_ID
			else process.env.AMP_USER_ID = previousUserID
		}
		try {
			;(tool.amp.system.user as { id: string }).id = previousUserID ?? 'user-test'
			;(tool.amp.system as { ampURL: URL }).ampURL = new URL('https://different.example')
			expect(await tool.execute({ name: 'API_KEY', scope: 'user' })).toContain('endpoint differs')
			expect(prompts).toBe(0)
		} finally {
			if (previousURL === undefined) delete process.env.AMP_URL
			else process.env.AMP_URL = previousURL
		}
	})

	test('disposal during secret input cannot start a later write', async () => {
		const root = temporaryRoot()
		const marker = join(root, 'ran')
		fakeAmp(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`)
		let submit: ((value: string) => void) | undefined
		const tool = toolWithUI({
			confirm: async () => true,
			input: async () => new Promise<string>((resolve) => { submit = resolve }),
		})
		const result = tool.execute({ name: 'API_KEY', scope: 'user' })
		for (let i = 0; !submit && i < 20; i++) await Bun.sleep(10)
		expect(submit).toBeDefined()
		await tool.dispose()
		submit!('fake-test-value')
		expect(await result).toContain('Plugin unloaded')
		expect(existsSync(marker)).toBe(false)
	})
})

test('timeout force-kills a command that ignores SIGTERM', async () => {
	const root = temporaryRoot()
	const marker = join(root, 'running')
	const binary = fakeAmp(root, `
require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid))
process.on('SIGTERM', () => {})
setInterval(() => {}, 100)
`)
	const state = executionState()
	const result = await runSecretCommand(binary, [], 'fake', root, 200, state)
	expect(result).toEqual({ kind: 'timeout' })
	expect(state.active.size).toBe(0)
	expect(existsSync(marker)).toBe(true)
})

test('timeout force-kills descendants after the CLI parent exits on SIGTERM', async () => {
	const root = temporaryRoot()
	const heartbeat = join(root, 'heartbeat')
	const binary = fakeAmp(root, `
const { spawn } = require('node:child_process')
const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(`
const fs = require('node:fs')
process.on('SIGTERM', () => {})
setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 30)
`)}], { stdio: 'ignore' })
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 100)
`)
	const state = executionState()
	const resultPromise = runSecretCommand(binary, [], 'fake', root, 300, state)
	await waitForFile(heartbeat)
	const result = await resultPromise
	expect(result).toEqual({ kind: 'timeout' })
	expect(state.pending.size).toBe(1)
	await Bun.sleep(2_150)
	expect(state.pending.size).toBe(0)
	const lastHeartbeat = readFileSync(heartbeat, 'utf8')
	await Bun.sleep(120)
	expect(readFileSync(heartbeat, 'utf8')).toBe(lastHeartbeat)
})

test('dispose terminates an in-flight command without reporting success', async () => {
	const root = temporaryRoot()
	const marker = join(root, 'running')
	fakeAmp(root, `
require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid))
process.on('SIGTERM', () => {})
setInterval(() => {}, 100)
`)
	const tool = toolWithUI({ confirm: async () => true, input: async () => 'fake-test-value' })
	const result = tool.execute({ name: 'API_KEY', scope: 'user' })
	await waitForFile(marker)
	await tool.dispose()
	expect(await result).not.toContain('Stored API_KEY')
})

test('dispose does not report success when SIGTERM makes the CLI exit zero', async () => {
	const root = temporaryRoot()
	const marker = join(root, 'running')
	fakeAmp(root, `
require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid))
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 100)
`)
	const tool = toolWithUI({ confirm: async () => true, input: async () => 'fake-test-value' })
	const result = tool.execute({ name: 'API_KEY', scope: 'user' })
	await waitForFile(marker)
	await tool.dispose()
	expect(await result).toContain('Plugin unloaded before completion')
})

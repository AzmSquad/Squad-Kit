import { describe, it, expect } from 'vitest';
import { KNOWN_BAD, KNOWN_BAD_GROUPS, RECOMMENDED, RECOMMENDED_GROUPS, hostMatches, knownBadGroup } from '../src/engine/network-lists.js';
import { NETWORK_LEVELS, NETWORK_WORDS, hostsProblem, networkPolicy, parseHosts, parseNetwork } from '../src/engine/sandbox.js';
import { networkRule } from '../src/engine/prompts.js';

/**
 * The project's network level (1.3.3): the two shipped lists, and the one policy both guards read. Standard: any site
 * but the known-bad ones. Strict: the recommended sites and the project's own. Off: nothing outside this computer.
 */

/** A host as Claude Code's sandbox takes it in its settings: a name, or "*." and a name of two labels or more. */
const SANDBOX_HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

describe('the lists', () => {
  it('are host names the sandbox takes, each once, with no path', () => {
    for (const h of [...RECOMMENDED, ...KNOWN_BAD]) {
      expect(h, h).toMatch(SANDBOX_HOST);
      // "*.com" would open a whole ending: the sandbox refuses it, and so does this list.
      if (h.startsWith('*.')) expect(h.slice(2).split('.').length, h).toBeGreaterThanOrEqual(2);
    }
    expect(new Set(RECOMMENDED).size).toBe(RECOMMENDED.length);
    expect(new Set(KNOWN_BAD).size).toBe(KNOWN_BAD.length);
  });

  it('never close a recommended site', () => {
    for (const h of RECOMMENDED) expect(knownBadGroup(h), h).toBeNull();
    for (const bad of KNOWN_BAD) for (const ok of RECOMMENDED) expect(hostMatches(ok.replace(/^\*\./, 'x.'), bad), `${ok} under ${bad}`).toBe(false);
  });

  it("keep every site squad-kit reached before, and the ones real stacks download from", () => {
    const before = ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org', 'repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org', 'downloads.gradle.org', 'api.nuget.org', 'globalcdn.nuget.org', 'rubygems.org', 'index.rubygems.org', 'crates.io', 'index.crates.io', 'static.crates.io', 'proxy.golang.org', 'sum.golang.org', 'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'cdn.playwright.dev', 'playwright.download.prss.microsoft.com', 'playwright.azureedge.net'];
    expect(RECOMMENDED).toEqual(expect.arrayContaining(before));
    // Prisma's engines, Google's Maven, Flutter's packages and SDK, Cypress, CocoaPods, Packagist, .NET.
    expect(RECOMMENDED).toEqual(expect.arrayContaining(['binaries.prisma.sh', 'dl.google.com', 'maven.google.com', 'pub.dev', 'storage.googleapis.com', 'download.cypress.io', 'cdn.cocoapods.org', 'repo.packagist.org', 'builds.dotnet.microsoft.com']));
    // The pull request host's address stays off: no agent has a key for it anyway.
    expect(RECOMMENDED).not.toContain('api.github.com');
  });

  it('close tunnels, paste and drop sites and request catchers, under every name they use', () => {
    for (const h of ['ngrok.io', 'abc.ngrok-free.app', 'x.trycloudflare.com', 'me.loca.lt', 'serveo.net', 'pastebin.com', 'transfer.sh', '0x0.st', 'webhook.site', 'abc.oast.fun', 'x.burpcollaborator.net', 'canarytokens.com']) {
      expect(knownBadGroup(h), h).not.toBeNull();
    }
    // A wildcard typed for one of them is closed too; a site that only looks alike is not.
    expect(knownBadGroup('*.ngrok.io')).toBe('Tunnels that open this computer to the internet');
    expect(knownBadGroup('ngrok.example.com')).toBeNull();
    expect(KNOWN_BAD_GROUPS.map((g) => g.name)).toEqual(['Tunnels that open this computer to the internet', 'Paste and file-drop sites', 'Request catchers and out-of-band test hosts']);
    expect(RECOMMENDED_GROUPS.every((g) => g.hosts.length > 0)).toBe(true);
  });

  it('match a host the way the sandbox does', () => {
    expect(hostMatches('a.b.example.com', '*.example.com')).toBe(true);
    expect(hostMatches('example.com', '*.example.com')).toBe(false);
    expect(hostMatches('Example.COM.', 'example.com')).toBe(true);
    expect(hostMatches('anything.dev', '*')).toBe(true);
  });
});

describe('one policy for both guards', () => {
  it('Standard: any host, with the recommended ones beside it, the known-bad closed, the project commands open', () => {
    const p = networkPolicy('standard', ['nexus.example.com'], 'darwin');
    expect(p.hosts).toEqual(['*', ...RECOMMENDED, 'nexus.example.com']);
    expect(p.noHosts).toEqual(KNOWN_BAD);
    expect(p.commands).toBe('internet');
  });

  it("Strict: the recommended sites and the project's own, never a known-bad one; the project commands as before", () => {
    const p = networkPolicy('strict', ['nexus.example.com', 'abc.ngrok.io'], 'darwin');
    expect(p.hosts).toEqual([...RECOMMENDED, 'nexus.example.com']);
    expect(p.noHosts).toEqual(KNOWN_BAD);
    expect(p.commands).toBe('internet');
  });

  it("Off: nothing outside this computer for the agents, and for the project's commands where the guard can say so", () => {
    expect(networkPolicy('off', ['nexus.example.com'], 'darwin')).toEqual({ level: 'off', hosts: [], noHosts: KNOWN_BAD, commands: 'this-computer' });
    // Bubblewrap could only give the command a network of its own, where the app squad-kit started is out of reach.
    expect(networkPolicy('off', [], 'linux').commands).toBe('internet');
  });

  it('Standard is the default, and a level is read whatever its case', () => {
    expect(networkPolicy().level).toBe('standard');
    expect(parseNetwork(' Strict ')).toBe('strict');
    expect(parseNetwork('OFF')).toBe('off');
    expect(parseNetwork('loose')).toBeNull();
    expect(parseNetwork(undefined)).toBeNull();
  });

  it('says each level in one plain sentence', () => {
    for (const l of NETWORK_LEVELS) {
      expect(NETWORK_WORDS[l], l).toMatch(/^[A-Z][^.]*\.$/);
      expect(NETWORK_WORDS[l], l).not.toMatch(/sandbox|proxy|allowlist|egress|seatbelt|bubblewrap/i);
    }
  });
});

describe('what the agents are told', () => {
  it('says where their commands go, and that a refused site is closed on purpose and never taken to the person', () => {
    expect(networkRule('standard')).toContain('any website except a few closed ones');
    expect(networkRule('strict')).toContain('only the official package and download sites');
    expect(networkRule('off')).toContain('no website at all, only this computer');
    for (const l of NETWORK_LEVELS) {
      expect(networkRule(l)).toContain('closed for this project on purpose');
      expect(networkRule(l)).toContain('never ask the person to open it');
      expect(networkRule(l)).toContain('go on without it');
    }
    // Off has no registry to go to.
    expect(networkRule('off')).not.toContain('registry');
  });
});

describe("the project's own sites", () => {
  it('keep a known-bad site out, with a plain reason', () => {
    const p = parseHosts(['nexus.example.com', 'pastebin.com', '*.ngrok.io']);
    expect(p).toEqual({ hosts: ['nexus.example.com'], bad: [], closed: ['pastebin.com', '*.ngrok.io'] });
    expect(hostsProblem(p)).toBe('pastebin.com stays closed for every project: it is one of the paste and file-drop sites, which a build never needs.');
    expect(hostsProblem(parseHosts(['nexus.example.com']))).toBeNull();
    expect(hostsProblem(parseHosts(['*']))).toBe('"*" is not a host name. Write it like nexus.example.com, or *.example.com for all of its subdomains.');
  });
});

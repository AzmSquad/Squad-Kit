/**
 * The two lists behind the project's network level (engine/sandbox.ts makes the policy from them). Both ship with
 * squad-kit and change with each release: a host added here reaches every project with the next version.
 *
 * - KNOWN_BAD: sites with no use in building or testing software, but common for taking data out or hiding traffic:
 *   tunnels, paste and file-drop sites, request catchers and out-of-band test hosts. Closed on every level. Kept
 *   short on purpose: nothing a normal build, install or test needs belongs here.
 * - RECOMMENDED: the official hosts of every common ecosystem, as wide as the large allowlists coding services ship.
 *   Strict reaches these and the project's own sites only. Each group has a name people know, for the Harness page.
 *
 * A host is written as the agent's own sandbox reads it: "example.com" is that host alone, "*.example.com" every host
 * under it (not example.com itself). Paths cannot be named, so a list that names one path of a host names the host.
 */

export interface SiteGroup {
  /** What people call these sites, for the Harness page. */
  name: string;
  hosts: string[];
}

/** Sites closed on every level, whatever else allows them. */
export const KNOWN_BAD_GROUPS: SiteGroup[] = [
  {
    name: 'Tunnels that open this computer to the internet',
    hosts: [
      'ngrok.io', '*.ngrok.io', 'ngrok.app', '*.ngrok.app', 'ngrok-free.app', '*.ngrok-free.app', 'ngrok.dev', '*.ngrok.dev', 'ngrok-free.dev', '*.ngrok-free.dev', '*.ngrok.com', 'ngrok-agent.com', '*.ngrok-agent.com',
      'trycloudflare.com', '*.trycloudflare.com',
      'loca.lt', '*.loca.lt', 'localtunnel.me', '*.localtunnel.me',
      'serveo.net', '*.serveo.net', 'serveousercontent.com', '*.serveousercontent.com',
      'pagekite.me', '*.pagekite.me', 'pagekite.net', '*.pagekite.net',
      'localhost.run', '*.localhost.run', 'lhr.life', '*.lhr.life',
      'pinggy.io', '*.pinggy.io', 'pinggy.link', '*.pinggy.link',
      'bore.pub', '*.bore.pub',
      'tunnelmole.net', '*.tunnelmole.net',
      'localxpose.io', '*.localxpose.io', 'loclx.io', '*.loclx.io',
      'zrok.io', '*.zrok.io',
      '*.devtunnels.ms',
      'sharedwithexpose.com', '*.sharedwithexpose.com',
      'localtonet.com', '*.localtonet.com', 'localto.net', '*.localto.net',
      'playit.gg', '*.playit.gg',
    ],
  },
  {
    name: 'Paste and file-drop sites',
    hosts: [
      'pastebin.com', '*.pastebin.com', 'paste.ee', 'hastebin.com', 'termbin.com', 'ix.io', 'sprunge.us', 'paste.rs', 'dpaste.com', 'dpaste.org',
      'rentry.co', 'rentry.org', 'controlc.com', 'justpaste.it', 'privatebin.net', 'pastes.io', 'paste.c-net.org',
      'transfer.sh', '*.transfer.sh', 'file.io', '0x0.st', 'temp.sh', 'bashupload.com', 'oshi.at', 'keep.sh', 'filebin.net', 'tmpfiles.org',
      'catbox.moe', '*.catbox.moe', 'gofile.io', '*.gofile.io', 'uguu.se', '*.uguu.se', 'pixeldrain.com',
    ],
  },
  {
    name: 'Request catchers and out-of-band test hosts',
    hosts: [
      'webhook.site', '*.webhook.site', 'requestbin.net', '*.requestbin.net', '*.m.pipedream.net', 'requestcatcher.com', '*.requestcatcher.com', 'hookbin.com', 'postb.in', 'ptsv2.com', 'ptsv3.com',
      'requestrepo.com', '*.requestrepo.com',
      'interact.sh', '*.interact.sh', 'interactsh.com', '*.interactsh.com', '*.oast.pro', '*.oast.live', '*.oast.site', '*.oast.online', '*.oast.fun', '*.oast.me',
      'burpcollaborator.net', '*.burpcollaborator.net', 'oastify.com', '*.oastify.com',
      'canarytokens.com', '*.canarytokens.com', 'canarytokens.org', '*.canarytokens.org',
      'dnslog.cn', '*.dnslog.cn', 'ceye.io', '*.ceye.io', '*.xss.ht',
    ],
  },
];

/** Every common ecosystem's official hosts, by the name people know them by. */
export const RECOMMENDED_GROUPS: SiteGroup[] = [
  {
    name: 'npm',
    hosts: ['registry.npmjs.org', 'registry.npmjs.com', 'npmjs.org', 'npmjs.com', 'skimdb.npmjs.com', 'npm.pkg.github.com', 'registry.yarnpkg.com', 'repo.yarnpkg.com', 'yarnpkg.com', 'get.pnpm.io', 'registry.bower.io'],
  },
  { name: 'Node.js, Bun and Deno', hosts: ['nodejs.org', 'deb.nodesource.com', 'bun.sh', 'deno.land', 'dl.deno.land', 'jsr.io'] },
  { name: 'Prisma', hosts: ['binaries.prisma.sh'] },
  {
    name: 'PyPI',
    hosts: ['pypi.org', 'pypi.python.org', 'files.pythonhosted.org', '*.pythonhosted.org', 'pip.pypa.io', 'bootstrap.pypa.io', 'install.python-poetry.org', 'conda.anaconda.org', 'repo.anaconda.com', 'anaconda.org', 'conda.binstar.org', 'binstar.org', 'repo.continuum.io', 'download.pytorch.org'],
  },
  {
    name: 'RubyGems',
    hosts: ['rubygems.org', 'index.rubygems.org', 'api.rubygems.org', 'bundler.rubygems.org', 'rubygems.pkg.github.com', 'gems.rubyonrails.org', 'cache.ruby-lang.org', '*.rvm.io'],
  },
  {
    name: 'Maven and Gradle',
    hosts: [
      'repo.maven.apache.org', 'repo1.maven.org', 'maven.apache.org', 'search.maven.org', 'maven-central.storage-download.googleapis.com', 'maven.pkg.github.com', 'oss.sonatype.org', 'repo.spring.io', 'maven.oracle.com', 'repo.grails.org', 'download.eclipse.org',
      'services.gradle.org', 'plugins.gradle.org', 'plugins-artifacts.gradle.org', 'downloads.gradle.org', 'downloads.gradle-dn.com', 'gradle.org',
    ],
  },
  {
    name: 'Java and Kotlin downloads',
    hosts: ['jdk.java.net', 'api.adoptium.net', 'adoptium.net', 'download.oracle.com', 'www.java.com', 'cache-redirector.jetbrains.com', 'download.jetbrains.com', 'packages.jetbrains.team', 'maven.pkg.jetbrains.space'],
  },
  { name: 'Google Maven and Android', hosts: ['maven.google.com', 'dl.google.com', 'dl-ssl.google.com'] },
  {
    name: 'NuGet and .NET',
    hosts: [
      'api.nuget.org', 'globalcdn.nuget.org', 'nuget.org', 'www.nuget.org', 'dist.nuget.org', 'nuget.pkg.github.com', 'pkgs.dev.azure.com', 'nugetregistryv2prod.blob.core.windows.net', 'azuresearch-usnc.nuget.org', 'azuresearch-ussc.nuget.org',
      'dot.net', 'dotnet.microsoft.com', 'builds.dotnet.microsoft.com', 'ci.dot.net', 'dotnetcli.blob.core.windows.net', 'dotnetcli.azureedge.net', 'dotnetbuilds.azureedge.net', 'download.visualstudio.microsoft.com', 'aka.ms',
    ],
  },
  { name: 'Dart and Flutter', hosts: ['pub.dev', 'pub.dartlang.org', 'storage.googleapis.com', 'storage.flutter-io.cn'] },
  { name: 'Packagist', hosts: ['repo.packagist.org', 'packagist.org', 'getcomposer.org'] },
  { name: 'Go modules', hosts: ['proxy.golang.org', 'sum.golang.org', 'go.dev', 'golang.org', 'pkg.go.dev', 'goproxy.io'] },
  { name: 'crates.io', hosts: ['crates.io', 'index.crates.io', 'static.crates.io', 'static.rust-lang.org', 'sh.rustup.rs'] },
  { name: 'CocoaPods and Swift', hosts: ['cocoapods.org', 'cdn.cocoapods.org', 'trunk.cocoapods.org', 'swift.org', 'download.swift.org'] },
  { name: 'Haskell and Perl', hosts: ['haskell.org', '*.hackage.haskell.org', 'hackage.haskell.org', 'get-ghcup.haskell.org', 'downloads.haskell.org', 'cpan.org', 'www.cpan.org', 'metacpan.org', 'cpan.metacpan.org'] },
  { name: 'Elixir, R and Julia', hosts: ['hex.pm', 'repo.hex.pm', 'builds.hex.pm', 'cdn.hex.pm', 'cran.r-project.org', 'cloud.r-project.org', 'pkg.julialang.org', 'julialang-s3.julialang.org'] },
  { name: 'Bazel', hosts: ['bcr.bazel.build', 'releases.bazel.build', 'mirror.bazel.build'] },
  {
    name: 'GitHub downloads',
    hosts: ['github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'raw.githubusercontent.com', '*.githubusercontent.com', 'lfs.github.com', 'github-cloud.s3.amazonaws.com', 'ghcr.io'],
  },
  {
    // Puppeteer's Chrome comes from storage.googleapis.com, listed with Dart and Flutter.
    name: 'Browsers for browser tests',
    hosts: ['cdn.playwright.dev', 'playwright.download.prss.microsoft.com', 'playwright.azureedge.net', 'playwright-akamai.azureedge.net', 'playwright-verizon.azureedge.net', 'download.cypress.io', 'cdn.cypress.io', 'googlechromelabs.github.io', 'edgedl.me.gvt1.com'],
  },
  { name: 'Container images', hosts: ['registry.hub.docker.com', '*.docker.io', '*.docker.com', 'quay.io', 'mcr.microsoft.com', 'gcr.io', 'public.ecr.aws'] },
  {
    name: 'Linux packages',
    hosts: [
      'archive.ubuntu.com', 'security.ubuntu.com', 'ppa.launchpad.net', 'keyserver.ubuntu.com', 'deb.debian.org', 'security.debian.org', 'apt.llvm.org', 'dl.fedoraproject.org', 'mirrors.fedoraproject.org', 'download.fedoraproject.org',
      'dl-cdn.alpinelinux.org', 'packagecloud.io', 'packages.cloud.google.com', 'packages.microsoft.com', 'formulae.brew.sh',
    ],
  },
  { name: 'Terraform and Kubernetes', hosts: ['releases.hashicorp.com', 'registry.terraform.io', 'dl.k8s.io', 'pkgs.k8s.io'] },
  { name: 'JSON schemas', hosts: ['json-schema.org', 'json.schemastore.org'] },
  {
    name: 'Certificate checks',
    hosts: [
      'ocsp.digicert.com', 'crl3.digicert.com', 'crl4.digicert.com', 'ocsp.sectigo.com', 'crl.sectigo.com', 'ocsp.usertrust.com', 'crl.usertrust.com', 'ocsp.globalsign.com', 'crl.globalsign.com',
      'ocsp.identrust.com', 'crl.identrust.com', 'ocsp.ssl.com', 'crls.ssl.com', 'oneocsp.microsoft.com', '*.o.lencr.org', '*.c.lencr.org',
    ],
  },
];

/** Every closed host, in one list. */
export const KNOWN_BAD: string[] = [...new Set(KNOWN_BAD_GROUPS.flatMap((g) => g.hosts))];

/** Every recommended host, in one list. */
export const RECOMMENDED: string[] = [...new Set(RECOMMENDED_GROUPS.flatMap((g) => g.hosts))];

/** True when the host is the pattern, or under it: "a.example.com" is under "*.example.com". The sandbox's own rule. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase();
  if (p === '*') return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return h === p;
}

/** The closed list a host is on, or null: an engineer's own site never opens one of these. */
export function knownBadGroup(host: string): string | null {
  // A pattern an engineer typed ("*.ngrok.io") is closed when the site it is under is.
  const bare = host.toLowerCase().replace(/^\*\./, '');
  return KNOWN_BAD_GROUPS.find((g) => g.hosts.some((p) => hostMatches(bare, p)))?.name ?? null;
}

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { compileIgnore } from '../src/pack-ignore.js'

const git = (text: string, base = '') => compileIgnore([{ base, text }], 'git')
const docker = (text: string) => compileIgnore([{ base: '', text }], 'docker')

// A file NAME containing a backslash cannot exist on Windows, where `\` is the separator, and the
// ignore package reads such a path as one there and refuses it. These cases are about posix names.
const itPosixNames = process.platform === 'win32' ? it.skip : it

describe('compileIgnore — shared syntax', () => {
  it('ignores blank lines and comments', () => {
    const ig = git('\n# a comment\n\n  \nbuild\n')
    expect(ig.excludes('build', true)).toBe(true)
    expect(ig.excludes('# a comment', false)).toBe(false)
  })

  it('treats a trailing-slash pattern as directory-only', () => {
    const ig = git('logs/\n')
    expect(ig.excludes('logs', true)).toBe(true)
    expect(ig.excludes('logs', false)).toBe(false)
  })

  it('matches a single path segment with * but not across a separator', () => {
    const ig = git('*.log\n')
    expect(ig.excludes('debug.log', false)).toBe(true)
    expect(ig.excludes('nested/debug.log', false)).toBe(true) // basename rule, not the star
    expect(git('src/*.log\n').excludes('src/deep/debug.log', false)).toBe(false)
  })

  it('crosses separators with **', () => {
    const ig = git('src/**/gen.js\n')
    expect(ig.excludes('src/gen.js', false)).toBe(true)
    expect(ig.excludes('src/a/b/gen.js', false)).toBe(true)
  })

  it('lets the last matching rule win, so order decides', () => {
    expect(git('*.log\n!keep.log\n').excludes('keep.log', false)).toBe(false)
    expect(git('!keep.log\n*.log\n').excludes('keep.log', false)).toBe(true)
  })
})

// git anchors only when the pattern has a slash; a bare name matches at any depth.
describe('compileIgnore — git anchoring', () => {
  it('matches a slashless pattern at any depth', () => {
    const ig = git('node_modules\n')
    expect(ig.excludes('node_modules', true)).toBe(true)
    expect(ig.excludes('packages/api/node_modules', true)).toBe(true)
  })

  it('anchors a pattern that starts with a slash', () => {
    const ig = git('/build\n')
    expect(ig.excludes('build', true)).toBe(true)
    expect(ig.excludes('src/build', true)).toBe(false)
  })

  it('anchors a pattern with an interior slash', () => {
    const ig = git('src/tmp\n')
    expect(ig.excludes('src/tmp', true)).toBe(true)
    expect(ig.excludes('vendor/src/tmp', true)).toBe(false)
  })

  it('scopes a nested ignore file to its own directory and below', () => {
    const ig = compileIgnore(
      [
        { base: '', text: 'a.txt\n' },
        { base: 'sub', text: 'b.txt\n' },
      ],
      'git',
    )
    expect(ig.excludes('b.txt', false)).toBe(false)
    expect(ig.excludes('sub/b.txt', false)).toBe(true)
    expect(ig.excludes('sub/a.txt', false)).toBe(true) // the root file still reaches down
  })

  it('lets a deeper ignore file override a shallower one', () => {
    const ig = compileIgnore(
      [
        { base: '', text: '*.log\n' },
        { base: 'sub', text: '!keep.log\n' },
      ],
      'git',
    )
    expect(ig.excludes('sub/keep.log', false)).toBe(false)
    expect(ig.excludes('keep.log', false)).toBe(true)
  })
})

describe('compileIgnore — docker anchoring', () => {
  it('anchors every pattern to the context root, slash or not', () => {
    const ig = docker('node_modules\n')
    expect(ig.excludes('node_modules', true)).toBe(true)
    expect(ig.excludes('packages/api/node_modules', true)).toBe(false)
  })

  it('needs an explicit **/ to reach any depth', () => {
    const ig = docker('**/node_modules\n')
    expect(ig.excludes('packages/api/node_modules', true)).toBe(true)
  })

  it('excludes everything under a matched directory', () => {
    const ig = docker('build\n')
    expect(ig.excludes('build/out/app.js', false)).toBe(true)
  })
})

// git cannot re-include under an excluded parent; docker can, so canPrune must stay conservative.
describe('compileIgnore — re-inclusion under an excluded directory', () => {
  it('keeps a git re-include suppressed under an excluded parent', () => {
    const ig = git('node_modules/\n!node_modules/keep.js\n')
    expect(ig.excludes('node_modules', true)).toBe(true)
    expect(ig.canPrune('node_modules')).toBe(true)
  })

  it('honours a docker re-include under an excluded parent', () => {
    const ig = docker('build\n!build/keep.js\n')
    expect(ig.excludes('build/keep.js', false)).toBe(false)
    expect(ig.excludes('build/other.js', false)).toBe(true)
    expect(ig.canPrune('build')).toBe(false)
  })

  it('still prunes a docker directory no negation can reach into', () => {
    const ig = docker('build\nvendor\n!build/keep.js\n')
    expect(ig.canPrune('vendor')).toBe(true)
  })
})

// `.gitignore` is what decides the upload boundary, so a rule that silently fails to match does
// not merely pack an extra file, it ships one the author explicitly withheld. Each of these is a
// documented gitignore(5) escape that the parser used to read as literal backslash text.
describe('compileIgnore — git escaping', () => {
  it('excludes a file whose name really starts with # via \\#', () => {
    const ig = git('\\#credentials\n')
    expect(ig.excludes('#credentials', false)).toBe(true)
    // Still a comment without the escape.
    expect(git('#credentials\n').excludes('#credentials', false)).toBe(false)
  })

  itPosixNames('does not read an escape as a rule about a backslash in the name', () => {
    expect(git('\\#credentials\n').excludes('\\#credentials', false)).toBe(false)
    expect(git('[\\\\].txt\n').excludes('\\.txt', false)).toBe(true)
  })

  it('excludes a file whose name really starts with ! via \\!, and does not read it as negation', () => {
    const ig = git('*\n\\!secrets\n')
    // The inverse failure is the dangerous one: unescaping before the negation check would turn
    // this into "re-include secrets", so assert the file is EXCLUDED, not merely matched.
    expect(ig.excludes('!secrets', false)).toBe(true)
    expect(git('\\!secrets\n').excludes('!secrets', false)).toBe(true)
  })

  it('keeps an escaped trailing space as part of the name', () => {
    const ig = git('private\\ \n')
    expect(ig.excludes('private ', false)).toBe(true)
    expect(ig.excludes('private', false)).toBe(false)
    // Unescaped trailing spaces are still ignored, which is the other half of the same rule.
    expect(git('private  \n').excludes('private', false)).toBe(true)
  })

  it('treats an escaped wildcard as the character itself', () => {
    const ig = git('\\*.log\n')
    expect(ig.excludes('*.log', false)).toBe(true)
    expect(ig.excludes('debug.log', false)).toBe(false)
  })

  it('does not let an escaped wildcard cut the prune head short', () => {
    // literalHead is consulted for docker negations only: the walker may not prune a directory a
    // re-include reaches into. It must read the escape the way translate does, or the head stops
    // at the `*` as "build\" and the directory holding keep.txt is pruned with the file inside it.
    const ig = docker('*\n!build\\*dir/keep.txt\n')
    expect(ig.excludes('build*dir/keep.txt', false)).toBe(false)
    expect(ig.canPrune('build*dir')).toBe(false)
    expect(ig.canPrune('other')).toBe(true)
  })

  it('still honours a CRLF file, where \\r is the line ending and not pattern text', () => {
    expect(git('build\r\nvendor\r\n').excludes('build', true)).toBe(true)
  })

  // docker's own parser trims and comments unconditionally, with no line-level escape, while its
  // matcher does honour `\` inside a pattern. Both halves pinned so the flavours cannot converge.
  it('leaves docker line parsing alone but still escapes inside a pattern', () => {
    expect(docker('\\*.log\n').excludes('*.log', false)).toBe(true)
    expect(docker('\\*.log\n').excludes('debug.log', false)).toBe(false)
    expect(docker('#comment\n').excludes('#comment', false)).toBe(false)
  })
})

// The git flavour's verdicts decide which files enter the archive, so the package producing them
// is part of the archive's identity, exactly as fflate is. A caret would let an install pick a
// release whose grammar differs and pack a different tree under the same digest.
describe('compileIgnore — the git grammar is a pinned dependency', () => {
  it('pins ignore to an exact version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies.ignore).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

// The `**` grammar and bracket expressions, against git's wildmatch and docker's patternmatcher.
// Every case here is a rule a real ignore file can carry, and each one either shipped a withheld
// file or dropped a kept one under some earlier hand-written matcher.
describe('compileIgnore — ** placement', () => {
  it('git: crosses directories only as a leading **/, a trailing /**, or /**/ in the middle', () => {
    expect(git('**/gen.js\n').excludes('a/b/gen.js', false)).toBe(true)
    expect(git('src/**/gen.js\n').excludes('src/gen.js', false)).toBe(true)
    expect(git('src/**/gen.js\n').excludes('src/a/b/gen.js', false)).toBe(true)
    expect(git('src/**\n').excludes('src/a/b', false)).toBe(true)
    expect(git('src/**\n').excludes('src', true)).toBe(false)
  })

  it('git: reads any other ** as a plain *, so it stays inside one segment', () => {
    const ig = git('*.env\n!a**b/keep.env\n')
    expect(ig.excludes('a/x/b/keep.env', false)).toBe(true) // still excluded: the negation does not reach
    expect(ig.excludes('axb/keep.env', false)).toBe(false)
    expect(ig.excludes('ab/keep.env', false)).toBe(false)
    expect(git('foo**bar\n').excludes('foo/bar', false)).toBe(false)
    expect(git('foo**bar\n').excludes('fooXbar', false)).toBe(true)
  })

  it('docker: crosses directories wherever ** stands, as patternmatcher does', () => {
    expect(docker('a**b/keep.env\n').excludes('a/x/b/keep.env', false)).toBe(true)
    expect(docker('**.log\n').excludes('sub/debug.log', false)).toBe(true)
    expect(docker('src/**\n').excludes('src', true)).toBe(false)
  })

  it('docker: an interior ** is an optional run of directories, never a run of characters', () => {
    const ig = docker('foo**bar\n')
    expect(ig.excludes('foobar', false)).toBe(true)
    expect(ig.excludes('foo/x/bar', false)).toBe(true)
    expect(ig.excludes('fooXbar', false)).toBe(false) // a local docker build keeps this file
  })

  it('docker: a leading ** with plain text after it is a suffix match, with glob syntax after it a directory run', () => {
    expect(docker('**foo\n').excludes('xfoo', false)).toBe(true) // patternmatcher's suffixMatch
    expect(docker('**foo\n').excludes('a/xfoo', false)).toBe(true)
    expect(docker('**fo?\n').excludes('fo1', false)).toBe(true)
    expect(docker('**fo?\n').excludes('a/fo1', false)).toBe(true)
    expect(docker('**fo?\n').excludes('xfo1', false)).toBe(false) // the regexp path: (.*/)?fo[^/]
  })

  it('docker: eats the slash after any **, so a**/b reaches ab at the root as well as a/x/b', () => {
    const ig = docker('a**/b\n')
    expect(ig.excludes('ab', false)).toBe(true) // (.*/)? matched nothing
    expect(ig.excludes('a/x/b', false)).toBe(true)
    expect(ig.excludes('ax/b', false)).toBe(true)
    expect(ig.excludes('axb', false)).toBe(false) // the optional group has to end at a slash
  })
})

describe('compileIgnore — bracket expressions', () => {
  it('docker: matches Unicode code points with ? and bracket ranges', () => {
    expect(docker('?.env').excludes('😀.env', false)).toBe(true)
    expect(docker('??.env').excludes('😀.env', false)).toBe(false)
    expect(docker('[😀-🙏].env').excludes('😁.env', false)).toBe(true)
    expect(docker('[^😀].env').excludes('😁.env', false)).toBe(true)
    expect(docker('[^😀].env').excludes('😀.env', false)).toBe(false)
  })

  it.each([
    ['alnum', '5', '-'], ['alpha', 'a', '5'], ['ascii', 'a', 'é'],
    ['blank', '\t', 'a'], ['cntrl', '\x01', 'a'], ['digit', '5', 'a'],
    ['graph', '!', ' '], ['lower', 'a', 'A'], ['print', ' ', '\x01'],
    ['punct', '-', 'a'], ['space', '\t', 'a'], ['upper', 'A', 'a'],
    ['word', '_', '-'], ['xdigit', 'f', 'g'],
  ])('docker: supports the ASCII POSIX class %s and its complement', (name, member, other) => {
    expect(docker(`[[:${name}:]].env`).excludes(`${member}.env`, false)).toBe(true)
    expect(docker(`[[:${name}:]].env`).excludes(`${other}.env`, false)).toBe(false)
    expect(docker(`[[:^${name}:]].env`).excludes(`${member}.env`, false)).toBe(false)
    expect(docker(`[[:^${name}:]].env`).excludes(`${other}.env`, false)).toBe(true)
    expect(docker(`[[:^${name}:]].env`).excludes('😀.env', false)).toBe(true)
  })

  it('docker: combines named classes, literals, ranges and outer negation', () => {
    const ig = docker('[a-c[:digit:][:upper:]_].env')
    for (const name of ['b.env', '5.env', 'A.env', '_.env']) expect(ig.excludes(name, false)).toBe(true)
    expect(ig.excludes('z.env', false)).toBe(false)
    expect(docker('[^[:digit:]].env').excludes('a.env', false)).toBe(true)
    expect(docker('[^[:digit:]].env').excludes('1.env', false)).toBe(false)
    expect(docker('[[:alpha:]].env').excludes('é.env', false)).toBe(false)
  })

  it.each(['[[:unknown:]]', '[[:constructor:]]', '[[:digit]]'])('docker: refuses malformed POSIX syntax %s instead of ignoring it', (pattern) => {
    expect(() => docker(pattern)).toThrow(/POSIX class in .dockerignore/)
  })

  it('treats a ] right after the opening [ as a member, so []] names a file called ]', () => {
    const ig = git('[]]\n')
    expect(ig.excludes(']', false)).toBe(true)
    expect(ig.excludes('a', false)).toBe(false)
    expect(git('[!]a]\n').excludes(']', false)).toBe(false)
    expect(git('[!]a]\n').excludes('a', false)).toBe(false)
    expect(git('[!]a]\n').excludes('b', false)).toBe(true)
  })

  it('keeps ranges and escapes inside a class', () => {
    expect(git('[a-c].txt\n').excludes('b.txt', false)).toBe(true)
    expect(git('[a-c].txt\n').excludes('d.txt', false)).toBe(false)
    expect(git('[\\]].txt\n').excludes('].txt', false)).toBe(true)
    // An escaped hyphen is a member, not a range: `[a\-c]` is the three characters a, - and c.
    expect(git('[a\\-c]\n').excludes('-', false)).toBe(true)
    expect(git('[a\\-c]\n').excludes('b', false)).toBe(false)
  })

  it('git: understands the POSIX named classes wildmatch does', () => {
    expect(git('[[:digit:]].env\n').excludes('1.env', false)).toBe(true)
    expect(git('[[:digit:]].env\n').excludes('a.env', false)).toBe(false)
    expect(git('[[:alpha:]][[:digit:]].log\n').excludes('a1.log', false)).toBe(true)
    expect(git('[[:alpha:]][[:digit:]].log\n').excludes('11.log', false)).toBe(false)
  })

  it('git: an unclosed [ matches nothing, as wildmatch aborts on it', () => {
    // An earlier hand-written matcher read it as a literal `[`. wildmatch.c returns WM_ABORT_ALL
    // for a class that never closes, so the rule is inert rather than a rule about a bracket.
    expect(git('[abc\n').excludes('[abc', false)).toBe(false)
    expect(git('[abc\n').excludes('a', false)).toBe(false)
  })

  it('never lets a negated class stand in for a separator', () => {
    expect(git('a[!x]b\n').excludes('a/b', false)).toBe(false)
    expect(git('a[!x]b\n').excludes('ayb', false)).toBe(true)
  })

  it.each(['private[^x]token', 'private[^[:digit:]]token'])('docker: %s can match a separator', (pattern) => {
    const ig = docker(pattern + '\n')
    expect(ig.excludes('private/token', false)).toBe(true)
    expect(ig.excludes('private/token/child', false)).toBe(true)
    expect(ig.excludes('privateytoken', false)).toBe(true)
    expect(ig.excludes('private5token', false)).toBe(pattern.includes('[^x]'))
    expect(ig.excludes('private/other', false)).toBe(false)
  })

  it('docker: a negated class also matches a separator in re-inclusion rules', () => {
    const ig = docker('private\n!private[^x]token\n')
    expect(ig.excludes('private/token', false)).toBe(false)
    expect(ig.excludes('private/other', false)).toBe(true)
    expect(ig.canPrune('private')).toBe(false)
  })

  it('docker: keeps a range a range, so [a-c] takes b', () => {
    expect(docker('[a-c].env\n').excludes('b.env', false)).toBe(true)
    expect(docker('[a-c].env\n').excludes('d.env', false)).toBe(false)
    expect(docker('[a\\-c].env\n').excludes('b.env', false)).toBe(false) // escaped: a member, not a range
  })

  it('docker: negates on ^ only, a ! is an ordinary member', () => {
    expect(docker('[^a].txt\n').excludes('b.txt', false)).toBe(true)
    expect(docker('[^a].txt\n').excludes('a.txt', false)).toBe(false)
    expect(docker('[!a].txt\n').excludes('!.txt', false)).toBe(true)
    expect(docker('[!a].txt\n').excludes('a.txt', false)).toBe(true)
    expect(docker('[!a].txt\n').excludes('b.txt', false)).toBe(false)
  })
})

// `.dockerignore` decides the upload boundary, so a rule that silently fails to match ships a
// file the author withheld. These are the shapes docker's own parser handles and this one did
// not (moby/patternmatcher ReadAll: BOM strip, comment test before trim, TrimSpace, Clean).
describe('compileIgnore — docker preprocessing parity', () => {
  it('strips a UTF-8 BOM, so a BOM-prefixed first rule still matches', () => {
    expect(docker('﻿secrets.env\n').excludes('secrets.env', false)).toBe(true)
    // Same for git: the BOM belongs to the file, not to the pattern.
    expect(git('﻿secrets.env\n').excludes('secrets.env', false)).toBe(true)
  })

  it('cleans a path so a traversal spelling still names the file it resolves to', () => {
    expect(docker('foo/../secrets.env\n').excludes('secrets.env', false)).toBe(true)
    expect(docker('./secrets.env\n').excludes('secrets.env', false)).toBe(true)
    expect(docker('a//b\n').excludes('a/b', false)).toBe(true)
  })

  // Clean drops the trailing slash, so docker has no directory-only form. Treating it as one
  // under-excludes: `secrets/` would then miss a FILE called secrets.
  it('matches a file for a trailing-slash rule, the way docker does', () => {
    const ig = docker('secrets/\n')
    expect(ig.excludes('secrets', true)).toBe(true)
    expect(ig.excludes('secrets', false)).toBe(true)
    // git keeps its own meaning: there, the slash really does mean directory-only.
    expect(git('secrets/\n').excludes('secrets', false)).toBe(false)
  })

  it('trims surrounding whitespace, and only treats an UNINDENTED hash as a comment', () => {
    expect(docker('   secrets.env   \n').excludes('secrets.env', false)).toBe(true)
    // docker tests for '#' before trimming, so an indented one is a pattern, not a comment.
    expect(docker('  #secrets\n').excludes('#secrets', false)).toBe(true)
    expect(docker('#secrets\n').excludes('#secrets', false)).toBe(false)
  })

  it('trims after the negation marker too', () => {
    const ig = docker('build\n!  build/keep.js\n')
    expect(ig.excludes('build/keep.js', false)).toBe(false)
  })
})

// `abc/**` means everything INSIDE abc. Reading it as "abc and everything inside" is not a
// near-miss: git-mode canPrune is unconditional, so the walker prunes abc outright and every
// re-inclusion beneath it becomes unreachable. A rule that reads as "drop this tree but keep one
// file" then silently drops the file too.
describe('compileIgnore — trailing /** matches descendants, not the directory', () => {
  it('does not exclude the directory itself', () => {
    const ig = git('abc/**\n')
    expect(ig.excludes('abc', true)).toBe(false)
    expect(ig.excludes('abc/x.txt', false)).toBe(true)
    expect(ig.excludes('abc/deep/y.txt', false)).toBe(true)
  })

  // The property that actually matters. canPrune is not consulted at all here (pack.ts asks it
  // only for a directory that IS excluded), so leaving abc unexcluded is exactly what lets the
  // walker descend and the negation be reached.
  it('leaves the directory walkable so a negation beneath it still applies', () => {
    const ig = git('abc/**\n!abc/keep.txt\n')
    expect(ig.excludes('abc', true)).toBe(false)
    expect(ig.excludes('abc/keep.txt', false)).toBe(false)
    expect(ig.excludes('abc/drop.txt', false)).toBe(true)
  })

  // Excluding the DIRECTORY is still a different rule with git's own consequence: git cannot
  // re-include under an excluded directory, and pruning there is correct.
  it('still prunes when the rule names the directory itself', () => {
    const ig = git('abc\n!abc/keep.txt\n')
    expect(ig.excludes('abc', true)).toBe(true)
    expect(ig.canPrune('abc')).toBe(true)
  })
})

// A nested .gitignore's own location is a directory NAME, not pattern syntax. Concatenating it
// into the pattern before translating meant a directory containing a character the glob grammar
// claims — all legal on posix — silently disabled every rule that file declared.
describe('compileIgnore — a nested ignore file under an odd directory name', () => {
  const nested = (base: string, text: string) => compileIgnore([{ base, text }], 'git')

  it.each([
    ['a backslash', 'we\\ird'],
    ['a star', 'we*ird'],
    ['a bracket', 'we[ird'],
    ['a plus', 'we+ird'],
  ])('applies its rules under a directory name containing %s', (_name, base) => {
    const ig = nested(base, 'secrets.env\n')
    expect(ig.excludes(`${base}/secrets.env`, false)).toBe(true)
    // And does not leak into a sibling whose name the metacharacter would have matched.
    expect(ig.excludes('weird/secrets.env', false)).toBe(false)
  })

  // Only the exclude is asserted: git-mode canPrune is unconditional, so it says nothing here.
  it('applies a directory-only rule under the real directory name', () => {
    const ig = nested('we*ird', 'build/\n')
    expect(ig.excludes('we*ird/build', true)).toBe(true)
    expect(ig.excludes('we*ird/build', false)).toBe(false)
  })
})

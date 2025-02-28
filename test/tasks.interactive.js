const path = require('path');
const test = require('ava');
const sh = require('shelljs');
const _ = require('lodash');
const sinon = require('sinon');
const Log = require('../lib/log');
const Spinner = require('../lib/spinner');
const Prompt = require('../lib/prompt');
const Config = require('../lib/config');
const runTasks = require('../lib/tasks');
const { mkTmpDir, gitAdd } = require('./util/helpers');
const ShellStub = require('./stub/shell');
const { interceptPublish: interceptGitLabPublish } = require('./stub/gitlab');
const { interceptDraft: interceptGitHubDraft, interceptPublish: interceptGitHubPublish } = require('./stub/github');

const noop = Promise.resolve();

const sandbox = sinon.createSandbox();

const testConfig = {
  ci: false,
  config: false,
  'disable-metrics': true
};

const log = sandbox.createStubInstance(Log);
const spinner = sandbox.createStubInstance(Spinner);
spinner.show.callsFake(({ enabled = true, task }) => (enabled ? task() : noop));

const defaultInquirer = {
  prompt: sinon.stub().callsFake(([options]) => {
    const answer = options.type === 'list' ? options.choices[0].value : options.name === 'version' ? '0.0.1' : true;
    return { [options.name]: answer };
  })
};

const getContainer = (options, inquirer = defaultInquirer) => {
  const config = new Config(Object.assign({}, testConfig, options));
  const shell = new ShellStub({ container: { log, config } });
  const prompt = new Prompt({ container: { inquirer } });
  return {
    log,
    spinner,
    config,
    shell,
    prompt
  };
};

const getHooks = plugins => {
  const hooks = {};
  ['before', 'after'].forEach(prefix => {
    plugins.forEach(ns => {
      ['init', 'beforeBump', 'bump', 'beforeRelease', 'release', 'afterRelease'].forEach(lifecycle => {
        hooks[`${prefix}:${lifecycle}`] = `echo ${prefix}:${lifecycle}`;
        hooks[`${prefix}:${ns}:${lifecycle}`] = `echo ${prefix}:${ns}:${lifecycle}`;
      });
    });
  });
  return hooks;
};

test.serial.beforeEach(t => {
  const bare = mkTmpDir();
  const target = mkTmpDir();
  sh.pushd('-q', bare);
  sh.exec(`git init --bare .`);
  sh.exec(`git clone ${bare} ${target}`);
  sh.pushd('-q', target);
  gitAdd('line', 'file', 'Add file');
  t.context = { bare, target };
});

test.serial.afterEach(() => {
  sandbox.resetHistory();
});

test.serial('should run tasks without throwing errors', async t => {
  sh.mv('.git', 'foo');
  const { name, latestVersion, version } = await runTasks({}, getContainer());
  t.is(version, '0.0.1');
  t.true(log.obtrusive.firstCall.args[0].includes(`release ${name} (currently at ${latestVersion})`));
  t.regex(log.log.lastCall.args[0], /Done \(in [0-9]+s\.\)/);
});

test.serial('should not run hooks for disabled release-cycle methods', async t => {
  const hooks = getHooks(['version', 'git', 'github', 'gitlab', 'npm']);

  const container = getContainer({
    hooks,
    git: { push: false },
    github: { release: false },
    gitlab: { release: false },
    npm: { publish: false }
  });

  const exec = sandbox.spy(container.shell, 'execFormattedCommand');

  await runTasks({}, container);

  const commands = _.flatten(exec.args).filter(arg => typeof arg === 'string' && arg.startsWith('echo'));

  t.true(commands.includes('echo before:init'));
  t.true(commands.includes('echo after:afterRelease'));

  t.false(commands.includes('echo after:git:release'));
  t.false(commands.includes('echo after:github:release'));
  t.false(commands.includes('echo after:gitlab:release'));
  t.false(commands.includes('echo after:npm:release'));
});

test.serial('should not run hooks for cancelled release-cycle methods', async t => {
  const { target } = t.context;
  const pkgName = path.basename(target);
  gitAdd(`{"name":"${pkgName}","version":"1.0.0"}`, 'package.json', 'Add package.json');
  sh.exec('git tag 1.0.0');

  const hooks = getHooks(['version', 'git', 'github', 'gitlab', 'npm']);
  const inquirer = { prompt: sandbox.stub().callsFake(([options]) => ({ [options.name]: false })) };

  const container = getContainer(
    {
      increment: 'minor',
      hooks,
      github: { release: true, skipChecks: true },
      gitlab: { release: true, skipChecks: true },
      npm: { publish: true, skipChecks: true }
    },
    inquirer
  );

  const exec = sandbox.stub(container.shell, 'execFormattedCommand').callThrough();
  exec.withArgs('npm version 1.1.0 --no-git-tag-version').rejects();

  await runTasks({}, container);

  const commands = _.flatten(exec.args).filter(arg => typeof arg === 'string' && arg.startsWith('echo'));

  t.true(commands.includes('echo before:init'));
  t.true(commands.includes('echo after:afterRelease'));
  t.true(commands.includes('echo after:git:bump'));

  t.false(commands.includes('echo after:npm:bump'));
  t.false(commands.includes('echo after:git:release'));
  t.false(commands.includes('echo after:github:release'));
  t.false(commands.includes('echo after:gitlab:release'));
  t.false(commands.includes('echo after:npm:release'));

  exec.restore();
});

test.serial('should run "after:*:release" plugin hooks', async t => {
  const { bare, target } = t.context;
  const project = path.basename(bare);
  const pkgName = path.basename(target);
  const owner = path.basename(path.dirname(bare));
  gitAdd(`{"name":"${pkgName}","version":"1.0.0"}`, 'package.json', 'Add package.json');
  sh.exec('git tag 1.0.0');
  const sha = gitAdd('line', 'file', 'More file');

  interceptGitHubDraft({
    owner,
    project,
    body: { tag_name: '1.1.0', name: 'Release 1.1.0', body: `* More file (${sha})` }
  });
  interceptGitHubPublish({ owner, project, body: { tag_name: '1.1.0' } });

  interceptGitLabPublish({
    owner,
    project,
    body: {
      name: 'Release 1.1.0',
      tag_name: '1.1.0',
      description: `* More file (${sha})`
    }
  });

  const hooks = getHooks(['version', 'git', 'github', 'gitlab', 'npm']);

  const container = getContainer({
    increment: 'minor',
    hooks,
    github: { release: true, pushRepo: `https://github.com/${owner}/${project}`, skipChecks: true },
    gitlab: { release: true, pushRepo: `https://gitlab.com/${owner}/${project}`, skipChecks: true },
    npm: { name: pkgName, skipChecks: true }
  });

  const exec = sandbox.spy(container.shell, 'execFormattedCommand');

  await runTasks({}, container);

  const commands = _.flatten(exec.args).filter(arg => typeof arg === 'string' && arg.startsWith('echo'));

  t.true(commands.includes('echo after:git:bump'));
  t.true(commands.includes('echo after:npm:bump'));
  t.true(commands.includes('echo after:git:release'));
  t.true(commands.includes('echo after:github:release'));
  t.true(commands.includes('echo after:gitlab:release'));
  t.true(commands.includes('echo after:npm:release'));
});

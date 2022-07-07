#!/usr/bin/env node
const { execSync } = require('child_process');
const https = require('https');

const buildUrl = process.argv[2];
const mainBranchName = process.env.MAIN_BRANCH_NAME || process.argv[3];
const errorOnNoSuccessfulWorkflow = process.argv[4] === '1';
const allowOnHoldWorkflow = process.argv[5] === '1';
const workflowName = process.argv[6];
const ignoreMainBranchName = process.argv[7] === '1';
const circleToken = process.env.CIRCLE_API_TOKEN;

const [, host, project] = buildUrl.match(/https?:\/\/([^\/]+)\/(.*)\/\d+/);

let BASE_SHA;
(async () => {
  process.stdout.write(process.argv.join(' ') + '\n');
  if (!isCommintOnMainBranch('HEAD', mainBranchName)) {
    process.stdout.write('first if true\n');
    BASE_SHA = execSync(`git merge-base origin/${mainBranchName} HEAD`, { encoding: 'utf-8' });
  } else {
    process.stdout.write('first if false\n');
    try {
      process.stdout.write(`tring to find workflow ${workflowName}\n`);
      BASE_SHA = await findSuccessfulCommit(mainBranchName, workflowName);
      process.stdout.write(`BASE_SHA ${BASE_SHA}\n`);
    } catch (e) {
      process.stderr.write(e.message);
      process.exit(1);
    }

    if (!BASE_SHA) {
      if (errorOnNoSuccessfulWorkflow) {
        process.stdout.write(`
    Unable to find a successful workflow run on 'origin/${mainBranchName}'
    NOTE: You have set 'error-on-no-successful-workflow' on the step so this is a hard error.

    Is it possible that you have no runs currently on 'origin/${mainBranchName}'?
    - If yes, then you should run the workflow without this flag first.
    - If no, then you might have changed your git history and those commits no longer exist.`);
        process.exit(1);
      } else {
        process.stdout.write(`
WARNING: Unable to find a successful workflow run on 'origin/${mainBranchName}'.
We are therefore defaulting to use HEAD~1 on 'origin/${mainBranchName}'.

NOTE: You can instead make this a hard error by settting 'error-on-no-successful-workflow' on the step in your workflow.\n\n`);
        BASE_SHA = execSync(`git rev-parse HEAD~1`, { encoding: 'utf-8' });
      }
    } else {
      process.stdout.write(`
Found the last successful workflow run on 'origin/${mainBranchName}'.\n\n`);
    }
  }

  process.stdout.write(`Commit: ${BASE_SHA}\n`);
})();

async function findSuccessfulCommit(branch, workflowName) {
  const url = `https://${host}/api/v2/project/${project}/pipeline`;
  let nextPage;
  let foundSHA;

  do {
    const queryParams = [];
    if (!ignoreMainBranchName) {
      queryParams.push(`branch=${branch}`)
    }
    if (nextPage) {
      queryParams.push(`page-token=${nextPage}`)
    }
    const fullUrl = queryParams.length ? `${url}?${queryParams.join('&')}` : url;
    const { next_page_token, sha } = await getJson(fullUrl)
      .then(async ({ next_page_token, items }) => {
        const pipeline = await findSuccessfulPipeline(items, workflowName);
        return {
          next_page_token,
          sha: pipeline ? pipeline.vcs.revision : void 0
        };
      });

    foundSHA = sha;
    nextPage = next_page_token;
  } while (!foundSHA && nextPage);

  return foundSHA;
}

async function findSuccessfulPipeline(pipelines, workflowName) {
  for (const pipeline of pipelines) {
    if (!pipeline.errors.length
      && commitExists(pipeline.vcs.revision)
      && await isWorkflowSuccessful(pipeline.id, workflowName)) {
      return pipeline;
    }
  }
  return undefined;
}

function commitExists(commitSha) {
  try {
    execSync(`git cat-file -e ${commitSha}`, { stdio: ['pipe', 'pipe', null] });
    return true;
  } catch {
    return false;
  }
}

async function isWorkflowSuccessful(pipelineId, workflowName) {
  if (!workflowName) {
    return getJson(`https://${host}/api/v2/pipeline/${pipelineId}/workflow`)
      .then(({ items }) => items.every(item => (item.status === 'success') || (allowOnHoldWorkflow && item.status === 'on_hold')));
  } else {
    return getJson(`https://${host}/api/v2/pipeline/${pipelineId}/workflow`)
      .then(({ items }) => items.some(item => ((item.status === 'success') || (allowOnHoldWorkflow && item.status === 'on_hold')) && item.name === workflowName));
  }
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    let options = {};

    if (circleToken) {
      options.headers = {
        'Circle-Token': circleToken
      }
    }

    https.get(url, options, (res) => {
      let data = [];

      res.on('data', chunk => {
        data.push(chunk);
      });

      res.on('end', () => {
        const response = Buffer.concat(data).toString();
        resolve(JSON.parse(response));
      });
    }).on('error', error => reject(
      circleToken
        ? new Error(`Error: Pipeline fetching failed.\nCheck if you set the correct user CIRCLE_API_TOKEN.\n\n${error.toString()}`)
        : new Error(`Error: Pipeline fetching failed.\nIf this is private repo you will need to set CIRCLE_API_TOKEN\n\n${error.toString()}`)
    ));
  });
}

function isCommintOnMainBranch(commit, mainBranchName) {
  try {
    execSync(`git merge-base --is-ancestor ${commit} origin/${mainBranchName}`, { encoding: 'utf-8' })
    return true;
  } catch (e) {
    return false;
  }
}
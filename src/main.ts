import * as core from '@actions/core'
import * as github from '@actions/github'
import {exec} from 'child_process'
import {promisify} from 'util'
import {DataSetMap, computeDataSet, download_am_list} from './am_list'
import {diff_dataset_maps} from './diff_data'

const execAsync = promisify(exec)

const TOKEN = 'gh-token'
const TS_ROOTS = 'ts-roots'
const RS_ROOTS = 'rust-roots'
const AM_LIST_VERSION = 'v0.2.0'

async function run(): Promise<void> {
  try {
    core.startGroup('Event payload content')
    const payload = github.context.payload
    core.info(`The event payload: ${JSON.stringify(payload, undefined, 2)}`)
    core.warning(
      `The head ref is ${payload.pull_request?.head.ref} (${payload.pull_request?.head.sha})`
    )
    core.warning(
      `The base ref is ${payload.pull_request?.base.ref} (${payload.pull_request?.base.sha})`
    )
    core.endGroup()

    const token = core.getInput(TOKEN)
    const octokit = github.getOctokit(token, {
      userAgent: 'Autometrics/diff-metrics v1'
    })
    const ts_roots = core.getMultilineInput(TS_ROOTS)
    const rs_roots = core.getMultilineInput(RS_ROOTS)

    core.startGroup(`Downloading am_list ${AM_LIST_VERSION}`)
    const am_path = await download_am_list(octokit, AM_LIST_VERSION)
    core.endGroup()

    core.startGroup('[head] Building datasets for head branch')
    const new_datasets: DataSetMap = {}

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const ts_root of ts_roots) {
      core.warning('Typescript is not supported by am_list yet.')
    }
    for (const rs_root of rs_roots) {
      new_datasets[rs_root] = await computeDataSet(am_path, rs_root, 'rust')
    }

    core.info(JSON.stringify(new_datasets, undefined, 2))
    core.endGroup()

    core.startGroup('[base] Checking out base branch')
    try {
      const baseRef = payload.pull_request?.base.ref
      if (!baseRef) throw Error('missing context.payload.pull_request.base.ref')
      await execAsync(`git fetch -n origin ${baseRef}`)
      core.info('successfully fetched base.ref')
    } catch (_e1) {
      const e1: Error = _e1 as Error
      core.error(`fetching base.ref failed: ${e1.message}`)

      try {
        const baseSha = payload.pull_request?.base.sha
        await execAsync(`git fetch -n origin ${baseSha}`)
        core.info('successfully fetched base.sha')
      } catch (_e2) {
        const e2: Error = _e2 as Error
        core.error(`fetching base.sha failed: ${e2.message}`)
        try {
          await execAsync(`git fetch -n`)
        } catch (_e3) {
          const e3: Error = _e3 as Error
          core.error(`fetch failed: ${e3.message}`)
        }
      }
    }
    core.endGroup()

    core.startGroup('[base] Building datasets for base branch')
    const old_datasets: DataSetMap = {}

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const ts_root of ts_roots) {
      core.warning('Typescript is not supported by am_list yet.')
    }
    for (const rs_root of rs_roots) {
      old_datasets[rs_root] = await computeDataSet(am_path, rs_root, 'rust')
    }

    core.info(JSON.stringify(old_datasets, undefined, 2))
    core.endGroup()

    const dataset_diff = diff_dataset_maps(new_datasets, old_datasets)

    const issueRef = payload.pull_request?.number
    if (!issueRef) {
      core.info('no issue_ref found')
      return
    }
    core.startGroup(`Post comment on PR ${issueRef}`)

    const commentInfo = {
      ...github.context.repo,
      issue_number: issueRef
    }
    const comment = {
      ...commentInfo,
      body:
        'Autometrics Compare Metrics\n' +
        `<details><summary>Differences in Dataset</summary>${JSON.stringify(
          dataset_diff,
          undefined,
          2
        )}</details>\n` +
        `<details><summary>Old Dataset</summary>${JSON.stringify(
          old_datasets,
          undefined,
          2
        )}</details>\n` +
        `<details><summary>New Dataset</summary>${JSON.stringify(
          new_datasets,
          undefined,
          2
        )}</details>\n`
    }

    let commentId
    try {
      const comments = (await octokit.rest.issues.listComments(commentInfo))
        .data
      for (let i = comments.length; i--; ) {
        const c = comments[i]
        if (
          c.user?.type === 'Bot' &&
          (c.body ?? '').includes('Autometrics Compare Metrics')
        ) {
          commentId = c.id
          break
        }
      }
    } catch (_ee) {
      const ee: Error = _ee as Error
      core.error(`Error checking for previous comments: ${ee.message}`)
    }

    if (commentId) {
      core.info(`Updating previous comment #${commentId}`)
      try {
        await octokit.rest.issues.updateComment({
          ...github.context.repo,
          comment_id: commentId,
          body: comment.body
        })
      } catch (_ee) {
        const ee: Error = _ee as Error
        core.error(`Error editing previous comment: ${ee.message}`)
        commentId = null
      }
    }

    if (!commentId) {
      core.info('Creating new comment')
      try {
        await octokit.rest.issues.createComment(comment)
      } catch (_e) {
        const e: Error = _e as Error
        core.error(`Error creating comment: ${e.message}`)
        core.info(`Submitting a PR review comment instead...`)
        try {
          const issue =
            github.context.issue || github.context.payload.pull_request
          await octokit.rest.pulls.createReview({
            owner: issue.owner,
            repo: issue.repo,
            pull_number: issue.number,
            event: 'COMMENT',
            body: comment.body
          })
        } catch (_ee) {
          const ee: Error = _ee as Error
          core.error('Error creating PR review.')
          throw ee
        }
      }
    }
    core.endGroup()
  } catch (_e) {
    const e: Error = _e as Error
    core.setFailed(e.message)
  }
}

run()

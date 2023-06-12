// This handles taking a list of data models that describe the difference between datasets,
// and post the information as a comment on the PR the workflow has been triggered for.

import * as core from '@actions/core'
import {GitHub} from '@actions/github/lib/utils'
import {DataSetDiff, DataSetDiffMap} from './diff_data'
import {AmFunction, DataSet, DataSetMap} from './am_list'
import {Context} from '@actions/github/lib/context'

const COMMENT_HEADER = '# <i>Autometrics Compare Metrics</i>'
const COMMENT_FOOTER =
  '\n\n<a href="https://github.com/autometrics-dev/diff-metrics"><sub>Autometrics diff-metrics</sub></a>'

export type DiffStats = {
  old: DataSetMap
  new: DataSetMap
  diff: DataSetDiffMap
}

export async function update_or_post_comment(
  octokit: InstanceType<typeof GitHub>,
  context: Context,
  stats: DiffStats
): Promise<void> {
  const issue_number = context.payload.pull_request?.number || 0
  const commentInfo = {
    ...context.repo,
    issue_number
  }
  const comment = {
    ...commentInfo,
    body: format_comment(stats, context.repo.repo)
  }

  let commentId
  try {
    const comments = (await octokit.rest.issues.listComments(commentInfo)).data
    for (let i = comments.length; i--; ) {
      const c = comments[i]
      if (c.user?.type === 'Bot' && (c.body ?? '').includes(COMMENT_FOOTER)) {
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
        ...context.repo,
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
        const issue = context.issue || context.payload.pull_request
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
}

function format_comment(stats: DiffStats, repo_name: string): string {
  const header = `${COMMENT_HEADER}\n${format_summary(stats.diff)}`

  if (
    Object.entries(stats.diff).length === 0 ||
    Object.values(stats.diff).every(
      dataset_diff =>
        dataset_diff.newly_autometricized.length === 0 &&
        dataset_diff.no_longer_autometricized.length === 0
    )
  ) {
    return `${header}\n${COMMENT_FOOTER}`
  }

  return (
    `${header}\n` +
    `## Differences in Datasets\n${format_diff_map(stats.diff, repo_name)}\n` +
    '## Details\n' +
    `<details><summary>Old Dataset</summary>\n${format_dataset_map(
      stats.old,
      repo_name
    )}</details>\n` +
    `<details><summary>New Dataset</summary>\n${format_dataset_map(
      stats.new,
      repo_name
    )}</details>\n` +
    `${COMMENT_FOOTER}`
  )
}

function format_root(root: string, repo_name: string): string {
  if (root.startsWith('.')) {
    return repo_name + root.substring(1)
  }

  return root
}

function format_summary(diff: DataSetDiffMap): string {
  if (
    Object.entries(diff).length === 0 ||
    Object.values(diff).every(
      dataset_diff =>
        dataset_diff.newly_autometricized.length === 0 &&
        dataset_diff.no_longer_autometricized.length === 0
    )
  ) {
    return 'No change\n'
  }
  let additions = 0
  let removals = 0
  for (const [, diff_item] of Object.entries(diff)) {
    additions += diff_item.newly_autometricized.length
    removals += diff_item.no_longer_autometricized.length
  }

  if (additions >= removals) {
    return `${
      additions - removals
    } metrics added (+${additions} / -${removals})`
  } else {
    return `${
      removals - additions
    } metrics removed (+${additions} / -${removals})`
  }
}

function format_diff_map(diff: DataSetDiffMap, repo_name: string): string {
  if (Object.entries(diff).length === 0) {
    return 'No data to report\n'
  }
  let ret = ''
  for (const [root, diff_item] of Object.entries(diff)) {
    ret = `${ret}In \`${format_root(root, repo_name)}\`\n\n`
    ret = `${ret}${format_diff_table(diff_item)}\n\n`
  }

  return ret
}

function format_diff_table(diff: DataSetDiff): string {
  let ret = ''
  if (diff.newly_autometricized.length !== 0) {
    ret = `${ret} ![Green square](https://placehold.co/15x15/c5f015/c5f015.png) Newly annotated functions\n\n`
    ret = ret + table_am_function_list(diff.newly_autometricized)
  } else {
    ret = `${ret}No newly annotated function to report here.\n\n`
  }
  if (diff.no_longer_autometricized.length !== 0) {
    ret = `${ret} ![Red square](https://placehold.co/15x15/f03c15/f03c15.png) No longer annotated functions\n\n`
    ret = ret + table_am_function_list(diff.no_longer_autometricized)
  } else {
    ret = `${ret}No function that is no longer annotated to report here.\n\n`
  }

  return ret
}

function format_dataset_map(stat_map: DataSetMap, repo_name: string): string {
  if (Object.entries(stat_map).length === 0) {
    return 'No data to report\n'
  }
  let ret = ''
  for (const [root, dataset] of Object.entries(stat_map)) {
    ret = `${ret}In \`${format_root(root, repo_name)}\`\n\n`
    ret = `${ret}${format_dataset(dataset)}\n\n`
  }

  return ret
}

function format_dataset(dataset: DataSet): string {
  let ret = ''

  if (dataset.autometricized_functions.length !== 0) {
    ret = `${ret}Annotated functions\n\n`
    ret = ret + table_am_function_list(dataset.autometricized_functions)
  } else {
    ret = `${ret}No annotated function to report.\n\n`
  }

  return ret
}

function table_am_function_list(
  list: AmFunction[],
  force_single_table?: boolean
): string {
  const PER_MODULE_TABLES_THRESHOLD = 10
  if (list.length < PER_MODULE_TABLES_THRESHOLD || force_single_table) {
    let ret = ''

    ret = `${ret}|Module|Function|\n`
    ret = `${ret}|------|--------|\n`
    for (const fn of list) {
      ret = `${ret}|${fn.module}|${fn.function}|\n`
    }
    ret = `${ret}\n`

    return ret
  }

  let ret = ''

  const per_module_fn_list: {[module: string]: AmFunction[]} = {}
  for (const fn of list) {
    if (!per_module_fn_list.hasOwnProperty(fn.module)) {
      per_module_fn_list[fn.module] = []
    }

    per_module_fn_list[fn.module].push(fn)
  }

  for (const [module_name, module_list] of Object.entries(per_module_fn_list)) {
    ret = `${ret}Module ${module_name}:\n`
    ret = `${ret}${table_am_function_list(module_list, true)}\n`
  }

  return ret
}

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { releaseNotesAgent } from '../agents/release-notes-agent';
import {
  asanaSprintFetchInputSchema,
  asanaTaskSchema,
  fetchCompletedAsanaSprintTasks,
  postReleaseNotesToSlack,
  slackReleasePostInputSchema,
  upsertGithubReleaseNotes,
} from '../tools/release-automation-tools';

const githubConfigSchema = z.object({
  publishToGithub: z.boolean().default(true),
  githubRepoOwner: z.string().min(1).optional(),
  githubRepoName: z.string().min(1).optional(),
  githubTagName: z.string().min(1).optional(),
  githubReleaseName: z.string().min(1).optional(),
  githubTargetCommitish: z.string().min(1).optional(),
  githubReleaseDraft: z.boolean().default(false),
  githubReleasePrerelease: z.boolean().default(false),
});

const slackConfigSchema = z.object({
  publishToSlack: z.boolean().default(true),
  slackWebhook: slackReleasePostInputSchema.shape.slackWebhook,
});

export const asanaReleaseNotesWorkflowInputSchema = asanaSprintFetchInputSchema
  .omit({
    asanaProjectGid: true,
  })
  .extend({
    includeTaskLinks: z.boolean().default(true),
  })
  .merge(githubConfigSchema)
  .merge(slackConfigSchema);

const collectedTicketsSchema = asanaReleaseNotesWorkflowInputSchema.extend({
  tasks: z.array(asanaTaskSchema),
  taskCount: z.number().int().nonnegative(),
});

const generatedReleaseNotesSchema = collectedTicketsSchema.extend({
  releaseTitle: z.string(),
  summary: z.string(),
  highlights: z.array(z.string()),
  ticketBullets: z.array(z.string()),
});

const renderedReleaseNotesSchema = generatedReleaseNotesSchema.extend({
  markdown: z.string(),
});

const githubReleaseSchema = z.object({
  id: z.number().int(),
  url: z.string().url(),
  htmlUrl: z.string().url(),
  tagName: z.string(),
  updated: z.boolean(),
});

export const asanaReleaseNotesWorkflowOutputSchema = renderedReleaseNotesSchema.extend({
  slackPosted: z.boolean(),
  githubRelease: githubReleaseSchema.nullable(),
});

function slugifySprintName(sprintName: string) {
  const slug = sprintName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug.length > 0 ? `sprint-${slug}` : 'sprint-release';
}

function formatTaskLine(task: z.infer<typeof asanaTaskSchema>, includeTaskLinks: boolean) {
  const details = [task.assignee ? `Owner: ${task.assignee}` : undefined, task.completedAt ? `Completed: ${task.completedAt}` : undefined]
    .filter(Boolean)
    .join(' | ');
  const link = includeTaskLinks && task.permalinkUrl ? ` (${task.permalinkUrl})` : '';
  return `- ${task.name}${link}${details ? ` - ${details}` : ''}`;
}

const collectSprintTicketsStep = createStep({
  id: 'collect-sprint-tickets',
  description: 'Collects completed Asana tickets for the requested sprint.',
  inputSchema: asanaReleaseNotesWorkflowInputSchema,
  outputSchema: collectedTicketsSchema,
  execute: async ({ inputData }) => {
    const result = await fetchCompletedAsanaSprintTasks(inputData);

    return {
      ...inputData,
      tasks: result.tasks,
      taskCount: result.taskCount,
    };
  },
});

const summarizeReleaseNotesStep = createStep({
  id: 'summarize-release-notes',
  description: 'Creates a user-facing summary and bullet points from completed sprint tickets.',
  inputSchema: collectedTicketsSchema,
  outputSchema: generatedReleaseNotesSchema,
  execute: async ({ inputData }) => {
    const releaseTitle = inputData.githubReleaseName ?? `${inputData.sprintName} Release Notes`;

    if (inputData.taskCount === 0) {
      return {
        ...inputData,
        releaseTitle,
        summary: `No completed tickets matched ${inputData.sprintName}.`,
        highlights: ['No completed tickets matched the configured sprint filters.'],
        ticketBullets: [],
      };
    }

    const taskDigest = inputData.tasks.map(task => ({
      name: task.name,
      notes: task.notes.slice(0, 400),
      completedAt: task.completedAt,
      assignee: task.assignee,
      sectionName: task.sectionName,
      sprintValue: task.sprintValue,
    }));

    const result = await releaseNotesAgent.generate(
      [
        {
          role: 'user',
          content: `Write release notes for sprint ${inputData.sprintName} using only these completed tickets. Return concise, user-facing content with a short summary, 3 to 6 highlights, and one bullet for each completed ticket. Ticket data: ${JSON.stringify(taskDigest)}`,
        },
      ],
      {
        structuredOutput: {
          schema: z.object({
            summary: z.string(),
            highlights: z.array(z.string()).min(1),
            ticketBullets: z.array(z.string()),
          }),
        },
      },
    );

    return {
      ...inputData,
      releaseTitle,
      summary: result.object.summary,
      highlights: result.object.highlights,
      ticketBullets: result.object.ticketBullets,
    };
  },
});

const renderReleaseNotesStep = createStep({
  id: 'render-release-notes',
  description: 'Renders the generated release note sections into Markdown for Slack and GitHub.',
  inputSchema: generatedReleaseNotesSchema,
  outputSchema: renderedReleaseNotesSchema,
  execute: async ({ inputData }) => {
    const highlightLines = inputData.highlights.map(highlight => `- ${highlight}`).join('\n');
    const ticketSummaryLines = inputData.ticketBullets.length > 0
      ? inputData.ticketBullets.map(bullet => `- ${bullet}`).join('\n')
      : '- No completed tickets matched the configured sprint filters.';
    const ticketLines = inputData.tasks.map(task => formatTaskLine(task, inputData.includeTaskLinks)).join('\n');

    const markdown = [
      `# ${inputData.releaseTitle}`,
      '',
      `Sprint: ${inputData.sprintName}`,
      '',
      '## Summary',
      inputData.summary,
      '',
      '## Highlights',
      highlightLines,
      '',
      `## Completed Tickets (${inputData.taskCount})`,
      ticketSummaryLines,
      '',
      '## Ticket Inventory',
      ticketLines || '- No completed tickets matched the configured sprint filters.',
    ].join('\n');

    return {
      ...inputData,
      markdown,
    };
  },
});

const publishReleaseNotesStep = createStep({
  id: 'publish-release-notes',
  description: 'Publishes the rendered release notes to Slack and GitHub.',
  inputSchema: renderedReleaseNotesSchema,
  outputSchema: asanaReleaseNotesWorkflowOutputSchema,
  execute: async ({ inputData }) => {
    let slackPosted = false;
    if (inputData.publishToSlack) {
      await postReleaseNotesToSlack({
        markdown: inputData.markdown,
        slackWebhook: inputData.slackWebhook,
      });
      slackPosted = true;
    }

    let githubRelease: z.infer<typeof githubReleaseSchema> | null = null;
    if (inputData.publishToGithub) {
      githubRelease = await upsertGithubReleaseNotes({
        owner: inputData.githubRepoOwner,
        repo: inputData.githubRepoName,
        tagName: inputData.githubTagName ?? slugifySprintName(inputData.sprintName),
        releaseName: inputData.releaseTitle,
        body: inputData.markdown,
        targetCommitish: inputData.githubTargetCommitish,
        draft: inputData.githubReleaseDraft,
        prerelease: inputData.githubReleasePrerelease,
      });
    }

    return {
      ...inputData,
      slackPosted,
      githubRelease,
    };
  },
});

export const asanaReleaseNotesWorkflow = createWorkflow({
  id: 'asana-release-notes-workflow',
  description: 'Fetches completed Asana sprint tickets, summarizes them, and publishes release notes to Slack and GitHub.',
  inputSchema: asanaReleaseNotesWorkflowInputSchema,
  outputSchema: asanaReleaseNotesWorkflowOutputSchema,
})
  .then(collectSprintTicketsStep)
  .then(summarizeReleaseNotesStep)
  .then(renderReleaseNotesStep)
  .then(publishReleaseNotesStep)
  .commit();
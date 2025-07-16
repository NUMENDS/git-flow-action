import { GitHub } from '@/infra/github/protocols';

import { GitHubUtilsService, PRInfo } from '@/modules/utils/github';

const CHANGELOG_FILENAME = 'CHANGELOG.md';
const CHANGELOG_HEADER = '# Changelog';
const VERSION_PREFIX = '# V';
const SEPARATOR = '---';
const DEFAULT_RELEASE_MESSAGE = '- Release updates and improvements';

export interface ChangelogEntry {
    version: string;
    content: string;
}

export interface ChangelogManager {
    createOrUpdateChangelog(version: string, branch: string): Promise<void>;
}

export class ChangelogService implements ChangelogManager {
    private readonly github: GitHub;
    private readonly githubUtilsService: GitHubUtilsService;

    constructor(github: GitHub) {
        this.github = github;
        this.githubUtilsService = new GitHubUtilsService(github);
    }

    public async createOrUpdateChangelog(version: string, branch: string): Promise<void> {
        try {
            this.githubUtilsService.logInfo(`Creating/updating changelog for version: ${version}`);

            const prInfo = await this.githubUtilsService.getPRInfo(branch);
            const changelogEntry = this.createChangelogEntry(version, prInfo);
            const existingContent = await this.getExistingChangelogContent(branch);
            const updatedContent = this.mergeChangelogContent(existingContent, changelogEntry);

            await this.saveChangelogToRepository(updatedContent, version, branch);

            this.githubUtilsService.logInfo('Changelog updated successfully');
        } catch (error) {
            this.handleChangelogError(error);
        }
    }

    private createChangelogEntry(version: string, prInfo: PRInfo): string {
        const releaseContent = prInfo.body || DEFAULT_RELEASE_MESSAGE;
        const prLink = prInfo.url ? `[🔎 See PR](${prInfo.url})` : '';

        return `${VERSION_PREFIX}${version}

This release includes:

${releaseContent}

${prLink}

${SEPARATOR}
`;
    }

    private async getExistingChangelogContent(branch: string): Promise<string> {
        try {
            const content = await this.github.getFileContent(CHANGELOG_FILENAME, branch);
            this.githubUtilsService.logInfo('Found existing CHANGELOG.md in repository');
            return content;
        } catch (error) {
            this.githubUtilsService.logInfo(
                'CHANGELOG.md not found in repository, creating new one',
            );
            return '';
        }
    }

    private mergeChangelogContent(existingContent: string, newEntry: string): string {
        if (this.hasChangelogHeader(existingContent)) {
            return this.insertIntoExistingChangelog(existingContent, newEntry);
        }

        return this.createNewChangelog(existingContent, newEntry);
    }

    private hasChangelogHeader(content: string): boolean {
        return content.includes(CHANGELOG_HEADER);
    }

    private insertIntoExistingChangelog(existingContent: string, newEntry: string): string {
        const lines = existingContent.split('\n');
        const headerIndex = this.findChangelogHeaderIndex(lines);

        if (headerIndex === -1) {
            return this.createNewChangelog(existingContent, newEntry);
        }

        const firstVersionIndex = this.findFirstVersionIndex(lines, headerIndex);

        if (firstVersionIndex === -1) {
            return `${existingContent}\n\n${newEntry}`;
        }

        return this.insertEntryAtPosition(lines, newEntry, firstVersionIndex);
    }

    private findChangelogHeaderIndex(lines: string[]): number {
        return lines.findIndex(line => line.trim().startsWith(CHANGELOG_HEADER));
    }

    private findFirstVersionIndex(lines: string[], afterIndex: number): number {
        return lines.findIndex((line, index) =>
            index > afterIndex && line.trim().startsWith(VERSION_PREFIX),
        );
    }

    private insertEntryAtPosition(lines: string[], newEntry: string, position: number): string {
        const beforeVersions = lines.slice(0, position);
        const existingVersions = lines.slice(position);
        const beforePart = beforeVersions.join('\n');
        const existingPart = existingVersions.join('\n');

        return `${beforePart}\n${newEntry}\n${existingPart}`;
    }

    private createNewChangelog(existingContent: string, newEntry: string): string {
        return `${CHANGELOG_HEADER}\n\n${newEntry}\n${existingContent}`;
    }

    private async saveChangelogToRepository(
        content: string,
        version: string,
        branch: string,
    ): Promise<void> {
        const fileSha = await this.getFileShaSafely(branch);
        const commitMessage = this.createCommitMessage(version);

        await this.github.updateFile(
            CHANGELOG_FILENAME,
            content,
            commitMessage,
            branch,
            fileSha,
        );

        this.githubUtilsService.logInfo('Changelog committed successfully via GitHub API');
    }

    private async getFileShaSafely(branch: string): Promise<string> {
        try {
            const sha = await this.githubUtilsService.getFileSha(CHANGELOG_FILENAME, branch);
            this.githubUtilsService.logInfo('Updating existing CHANGELOG.md');
            return sha;
        } catch (error) {
            this.githubUtilsService.logInfo('Creating new CHANGELOG.md');
            return '';
        }
    }

    private createCommitMessage(version: string): string {
        return `docs: update changelog for version ${version}`;
    }

    private handleChangelogError(error: unknown): void {
        this.githubUtilsService.logInfo(`Error updating changelog: ${error}`);
        this.githubUtilsService.logInfo('Continuing with release process...');
    }
}


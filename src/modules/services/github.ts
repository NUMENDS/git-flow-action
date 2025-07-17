import { CreateTagParams } from '@/modules/git-flow/protocols';

import { GitHub } from '@/infra/github/protocols';

export interface PRInfo {
    body: string;
    url: string;
}

export interface GitHubUtilsManager {
    createTag(params: CreateTagParams): Promise<void>;
    getFileSha(filePath: string, branch: string): Promise<string>;
    getPRInfo(branch: string): Promise<PRInfo>;
    logInfo(message: string): void;
}

export class GitHubUtilsService implements GitHubUtilsManager {
    private readonly github: GitHub;

    constructor(github: GitHub) {
        this.github = github;
    }

    public async createTag(params: CreateTagParams): Promise<void> {
        const tag = this.getTagName(
            params.branches.current,
            params.prefixes.release,
            params.prefixes.tag,
        );

        this.logInfo(`SHA -------> ${params.sha}`);
        this.logInfo(`TAG -------> ${tag}`);

        await this.github.createTag(tag, params.sha);
    }

    private getTagName(currentBranch: string, releasePrefix: string, tagPrefix: string): string {
        const branchName = currentBranch.split(releasePrefix).join('');
        return `${tagPrefix}${branchName}`;
    }

    public async getFileSha(filePath: string, branch: string): Promise<string> {
        const instance = (this.github as any).getOctokitInstance();
        const response = await instance.repos.getContent({
            ...(this.github as any).client.context.repo,
            path: filePath,
            ref: branch,
        });
        return response.data.sha;
    }

    public async getPRInfo(branch: string): Promise<PRInfo> {
        this.logInfo(`Searching for PR: ${branch}`);

        const branchFormats = this.getBranchSearchFormats(branch);

        for (const branchFormat of branchFormats) {
            try {
                const prInfo = await this.searchPRByBranch(branchFormat);
                if (prInfo) {
                    return prInfo;
                }
            } catch (error) {
                this.logInfo(`Error searching with format '${branchFormat}': ${error}`);
                continue;
            }
        }

        throw new Error(`No Pull Request found for release branch '${branch}'`);
    }

    private getBranchSearchFormats(branch: string): string[] {
        const context = (this.github as any).client.context;

        return [
            branch,
            branch.replace(/^release\//, ''),
            `${context.repo.owner}:${branch}`,
        ];
    }

    private async searchPRByBranch(branchFormat: string): Promise<PRInfo | null> {
        const instance = (this.github as any).getOctokitInstance();
        const context = (this.github as any).client.context;

        const prs = await instance.pulls.list({
            ...context.repo,
            head: branchFormat,
            state: 'all',
        });

        if (!prs.data || prs.data.length === 0) {
            return null;
        }

        const pr = prs.data[0];
        return await this.buildPRInfo(pr, instance, context);
    }

    private async buildPRInfo(
        pr: any,
        instance: any,
        context: any,
    ): Promise<PRInfo> {
        this.logInfo(`✅ Found PR #${pr.number}: ${pr.title}`);

        const detailedPr = await instance.pulls.get({
            ...context.repo,
            pull_number: pr.number,
        });

        const body = this.getPRBody(detailedPr.data, pr);

        return {
            body,
            url: pr.html_url,
        };
    }

    private getPRBody(detailedPr: any, pr: any): string {
        const enhancedBody = detailedPr.body || pr.body || '';

        if (enhancedBody.trim()) {
            return enhancedBody;
        }

        return this.createFallbackPRDescription(detailedPr, pr);
    }

    private createFallbackPRDescription(detailedPr: any, pr: any): string {
        const title = detailedPr.title || pr.title;
        const changedFiles = detailedPr.changed_files || 'Unknown';
        const commits = detailedPr.commits || 'Multiple';

        return `**${title}**

This release includes changes from PR #${pr.number}.

**Changed files:** ${changedFiles} files modified
**Commits:** ${commits} commits included

For detailed information, please check the pull request.`;
    }

    public logInfo(message: string): void {
        this.github.getCore().info(message);
    }
}


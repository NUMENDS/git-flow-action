import { GitFlowBranchesPrefixes } from '@/modules/git-flow/protocols';
import { Branches } from '@/infra/github/protocols';
import { Client, Core } from '@/infra/github/protocols';
import { GitHub } from './protocols/git-hub';

export class GitHubService implements GitHub {
    private readonly client: Client;
    private readonly core: Core;
    private octokitInstance: InstanceType<any>;

    constructor(client: Client, core: Core) {
        this.client = client;
        this.core = core;
    }

    private connect(): any {
        const token = this.core.getInput('github_token');

        return this.client.getOctokit(token);
    }

    private getOctokitInstance(): InstanceType<any> {
        if (!this.octokitInstance) {
            this.octokitInstance = this.connect();
        }

        return this.octokitInstance;
    }

    public getCore(): Core {
        return this.core;
    }

    public async getBranches(): Promise<Branches> {
        const { current, target } = await this.getCurrentBranchName();
        return {
            current,
            target,
            main: this.core.getInput('master_branch'),
            development: this.core.getInput('development_branch'),
        };
    }

    private async getCurrentBranchName(): Promise<Pick<Branches, 'current' | 'target'>> {
        const branchName = this.client.context.ref;
        const pullRequest = branchName.split('refs/pull/').join('').replace('/merge', '');
        const branches = await this.getPullRequestHeadBranch(pullRequest);
        return branches;
    }

    private async getPullRequestHeadBranch(
        pull: string,
    ): Promise<Pick<Branches, 'current' | 'target'>> {
        const instance = this.getOctokitInstance();
        const response = await instance.pulls.get({
            ...this.client.context.repo,
            pull_number: pull,
        });
        return {
            current: response?.data?.head?.ref,
            target: response?.data?.base?.ref,
        };
    }

    public getPrefixes(): GitFlowBranchesPrefixes {
        return {
            bugfix: this.core.getInput('bugfix_branch_prefix'),
            feature: this.core.getInput('feature_branch_prefix'),
            hotfix: this.core.getInput('hotfix_branch_prefix'),
            release: this.core.getInput('release_branch_prefix'),
            support: this.core.getInput('support_branch_prefix'),
            tag: this.core.getInput('tag_prefix'),
        };
    }

    public async merge(fromBranch: string, toBranch: string): Promise<string> {
        const instance = this.getOctokitInstance();
        const response = await instance.repos.merge({
            ...this.client.context.repo,
            base: toBranch,
            head: fromBranch,
        });

        this.core.info(`TO BRANCH ------> ${toBranch}`);

        const sha = response.data?.sha;
        this.core.info(`sha ${sha}`);

        return sha;
    }

    public async delete(currentBranch: string): Promise<void> {
        const instance = this.getOctokitInstance();

        const payload = this.client.context.payload;
        const owner = payload.organization?.login ?
            payload.organization.login :
            this.client.context.actor;

        await instance.git.deleteRef({
            owner,
            repo: this.client.context.repo.repo,
            ref: `heads/${currentBranch}`,
        });
    }

    public async createTag(tag: string, sha: string): Promise<void> {
        const instance = this.getOctokitInstance();
        await instance.git.createRef({
            ...this.client.context.repo,
            ref: `refs/tags/${tag}`,
            sha,
        });
    }

    public async getFileContent(filePath: string, branch: string): Promise<string> {
        const instance = this.getOctokitInstance();
        try {
            const response = await instance.repos.getContent({
                ...this.client.context.repo,
                path: filePath,
                ref: branch,
            });

            if ('content' in response.data) {
                return atob(response.data.content);
            }
            throw new Error(`File ${filePath} not found or is not a file`);
        } catch (error) {
            this.core.info(`Error getting file content for ${filePath}: ${error}`);
            throw error;
        }
    }

    public async updateFile(
        filePath: string,
        content: string,
        message: string,
        branch: string,
        sha: string,
    ): Promise<void> {
        const instance = this.getOctokitInstance();
        try {
            await instance.repos.createOrUpdateFileContents({
                ...this.client.context.repo,
                path: filePath,
                message,
                content: btoa(content),
                branch,
                sha,
            });
            this.core.info(`Successfully updated ${filePath}`);
        } catch (error) {
            this.core.info(`Error updating file ${filePath}: ${error}`);
            throw error;
        }
    }
}

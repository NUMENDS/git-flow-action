import { CreateTagParams, GitFlowHandler } from '@/modules/git-flow/protocols';
import { Branches, GitHub } from '@/infra/github/protocols';
import { VersionManagerService } from '@/modules/version-manager';

export class Release implements GitFlowHandler {
    private readonly github: GitHub;
    private readonly versionManager: VersionManagerService;

    constructor(github: GitHub) {
        this.github = github;
        this.versionManager = new VersionManagerService();
    }

    public async test(): Promise<boolean> {
        const branches = await this.github.getBranches();
        const prefixes = this.github.getPrefixes();
        return branches.current.includes(prefixes.release);
    }

    public async handle(): Promise<string> {
        this.github.getCore().info('RELEASE HANDLER');
        const branches = await this.github.getBranches();
        const prefixes = this.github.getPrefixes();
        await this.updateVersionFiles(branches, prefixes);
        const sha = await this.merge(branches);
        await this.github.delete(branches.current);
        await this.createTag({ branches, prefixes, sha });

        return sha;
    }

    private async merge(branches: Branches): Promise<string> {
        await this.github.merge(branches.current, branches.development);
        const sha = await this.github.merge(branches.current, branches.main);

        return sha;
    }

    private async createTag(params: CreateTagParams): Promise<void> {
        const tag = this.getTagName(
            params.branches.current,
            params.prefixes.release,
            params.prefixes.tag,
        );

        this.github.getCore().info(`SHA -------> ${params.sha}`);
        this.github.getCore().info(`TAG -------> ${tag}`);

        await this.github.createTag(tag, params.sha);
    }

    private getTagName(currentBranch: string, releasePrefix: string, tagPrefix: string): string {
        const branchName = currentBranch.split(releasePrefix).join('');
        return `${tagPrefix}${branchName}`;
    }

    private async updateVersionFiles(branches: Branches, prefixes: any): Promise<void> {
        try {
            const version = this.versionManager.extractVersionFromBranch(
                branches.current,
                prefixes.release,
            );
            this.github.getCore().info(`Updating version files to: ${version}`);

            // Update package.json
            await this.updatePackageJson(version, branches.current);

            // Update mta.yaml (if exists)
            await this.updateMtaYaml(version, branches.current);

            this.github.getCore().info('Version files updated successfully');
        } catch (error) {
            this.github.getCore().info(`Error updating version files: ${error}`);
            throw error;
        }
    }

    private async updatePackageJson(version: string, branch: string): Promise<void> {
        try {
            const content = await this.github.getFileContent('package.json', branch);
            const updatedContent = this.versionManager.updatePackageJsonVersion(content, version);

            // Get current file SHA for updating
            const fileResponse = await this.getFileSha('package.json', branch);
            await this.github.updateFile(
                'package.json',
                updatedContent,
                `chore: update package.json version to ${version}`,
                branch,
                fileResponse,
            );

            this.github.getCore().info(`package.json version updated to: ${version}`);
        } catch (error) {
            this.github.getCore().info(`Error updating package.json: ${error}`);
            throw error;
        }
    }

    private async updateMtaYaml(version: string, branch: string): Promise<void> {
        try {
            const content = await this.github.getFileContent('mta.yaml', branch);
            const updatedContent = this.versionManager.updateMtaYamlVersion(content, version);

            // Get current file SHA for updating
            const fileResponse = await this.getFileSha('mta.yaml', branch);
            await this.github.updateFile(
                'mta.yaml',
                updatedContent,
                `chore: update mta.yaml version to ${version}`,
                branch,
                fileResponse,
            );

            this.github.getCore().info(`mta.yaml version updated to: ${version}`);
        } catch (error) {
            this.github.getCore().info(`mta.yaml file not found or error updating: ${error}`);
            // Don't throw error for mta.yaml as it might not exist in all projects
        }
    }

    private async getFileSha(filePath: string, branch: string): Promise<string> {
        const instance = (this.github as any).getOctokitInstance();
        const response = await instance.repos.getContent({
            ...(this.github as any).client.context.repo,
            path: filePath,
            ref: branch,
        });
        return response.data.sha;
    }
}

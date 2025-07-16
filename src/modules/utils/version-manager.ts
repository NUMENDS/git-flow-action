import { Branches, GitHub } from '@/infra/github/protocols';
import { GitHubUtilsService } from '@/modules/utils/github';

export const VERSION_FILES = {
    PACKAGE_JSON: {
        name: 'package.json',
        required: true,
    },
    MTA_YAML: {
        name: 'mta.yaml',
        required: false,
    },
} as const;

export type VersionFile = {
    name: string;
    required: boolean;
};

export type VersionUpdateStrategy = (content: string, version: string) => string;

export interface VersionManager {
    extractVersionFromBranch(branchName: string, releasePrefix: string): string;
    updateVersionFiles(branches: Branches, version: string): Promise<void>;
}

export class VersionManagerService implements VersionManager {
    private readonly github: GitHub;
    private readonly githubUtilsService: GitHubUtilsService;

    constructor(github: GitHub) {
        this.github = github;
        this.githubUtilsService = new GitHubUtilsService(github);
    }

    public extractVersionFromBranch(branchName: string, releasePrefix: string): string {
        const versionRegex = new RegExp(
            `^${releasePrefix.replace('/', '\\/')}([0-9]+\\.[0-9]+\\.[0-9]+)$`,
        );
        const match = branchName.match(versionRegex);

        if (!match) {
            throw new Error(`Branch name ${branchName} does not match release pattern`);
        }

        return match[1];
    }

    public async updateVersionFiles(branches: Branches, version: string): Promise<void> {
        this.githubUtilsService.logInfo(`Updating version files to: ${version}`);

        try {
            const filesToUpdate = this.getVersionFilesToUpdate();

            for (const file of filesToUpdate) {
                await this.updateVersionFile(
                    file.name,
                    version,
                    branches.current,
                    file.required,
                );
            }

            this.githubUtilsService.logInfo('Version files updated successfully');
        } catch (error) {
            this.githubUtilsService.logInfo(`Error updating version files: ${error}`);
            throw error;
        }
    }

    private getVersionFilesToUpdate(): VersionFile[] {
        return Object.values(VERSION_FILES);
    }

    private async updateVersionFile(
        fileName: string,
        version: string,
        branch: string,
        isRequired: boolean,
    ): Promise<void> {
        try {
            const content = await this.github.getFileContent(fileName, branch);
            const updatedContent = this.getUpdatedFileContent(fileName, content, version);
            const fileSha = await this.githubUtilsService.getFileSha(fileName, branch);

            await this.github.updateFile(
                fileName,
                updatedContent,
                this.createCommitVersionMessage(fileName, version),
                branch,
                fileSha,
            );
            this.githubUtilsService.logInfo(`${fileName} version updated to: ${version}`);
        } catch (error) {
            const errorMessage = `Error updating ${fileName}: ${error}`;
            this.githubUtilsService.logInfo(errorMessage);

            if (isRequired) {
                throw error;
            }
        }
    }

    private getUpdatedFileContent(fileName: string, content: string, version: string): string {
        const updateStrategy = this.getUpdateStrategy(fileName);
        return updateStrategy(content, version);
    }

    private getUpdateStrategy(fileName: string): VersionUpdateStrategy {
        const strategies: Record<string, VersionUpdateStrategy> = {
            [VERSION_FILES.PACKAGE_JSON.name]: (content: string, version: string) =>
                this.updatePackageJsonVersion(content, version),
            [VERSION_FILES.MTA_YAML.name]: (content: string, version: string) =>
                this.updateMtaYamlVersion(content, version),
        };

        const strategy = strategies[fileName];
        if (!strategy) {
            throw new Error(`Unsupported file type: ${fileName}`);
        }

        return strategy;
    }

    private updatePackageJsonVersion(content: string, version: string): string {
        try {
            const packageJson = JSON.parse(content);
            packageJson.version = version;
            return JSON.stringify(packageJson, null, 2);
        } catch (error) {
            throw new Error(`Failed to update package.json version: ${error}`);
        }
    }

    private updateMtaYamlVersion(content: string, version: string): string {
        try {
            const versionRegex = /^version:\s*.*/gm;
            return content.replace(versionRegex, `version: ${version}`);
        } catch (error) {
            throw new Error(`Failed to update mta.yaml version: ${error}`);
        }
    }

    private createCommitVersionMessage(fileName: string, version: string): string {
        return `chore: update ${fileName} version to ${version}`;
    }
}

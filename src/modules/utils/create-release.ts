import * as fs from 'fs';
import * as path from 'path';

import { GitHub } from '@/infra/github/protocols';
import { GitHubUtilsService, PRInfo } from '@/modules/utils/github';

const VERSION_TAG_PREFIX = 'v';
const RELEASE_NAME_PREFIX = 'Release v';
const ASSET_EXTENSIONS = {
    MTAR: '.mtar',
    ZIP: '.zip',
} as const;

export interface ReleaseConfig {
    version: string;
    projectName: string;
    releaseFilePath: string;
}

export interface ReleaseBody {
    version: string;
    description: string;
    projectName: string;
    repoInfo: RepoInfo;
    prUrl?: string;
}

export interface RepoInfo {
    owner: string;
    repo: string;
}

export interface ReleaseAsset {
    filePath: string;
    fileName: string;
    exists: boolean;
}

export interface CreateReleaseManager {
    createGitHubRelease(config: ReleaseConfig): Promise<void>;
}

export class CreateReleaseService implements CreateReleaseManager {
    private readonly github: GitHub;
    private readonly githubUtilsService: GitHubUtilsService;

    constructor(github: GitHub) {
        this.github = github;
        this.githubUtilsService = new GitHubUtilsService(github);
    }

    public async createGitHubRelease(config: ReleaseConfig): Promise<void> {
        try {
            this.githubUtilsService.logInfo(
                `Creating GitHub release for version ${config.version}`,
            );

            const prInfo = await this.getPRInformation(config.version);
            const releaseResponse = await this.createRelease(config, prInfo);

            this.githubUtilsService.logInfo(
                `Release created with ID: ${releaseResponse.data.id}, ` +
                `Tag: ${releaseResponse.data.tag_name}`,
            );
            await this.uploadReleaseAsset(releaseResponse.data.id, config.releaseFilePath);

            this.githubUtilsService.logInfo(
                `GitHub release created successfully: ${releaseResponse.data.html_url}`,
            );
        } catch (error) {
            this.githubUtilsService.logInfo(`Error creating GitHub release: ${error}`);
            throw error;
        }
    }

    private async getPRInformation(version: string): Promise<PRInfo> {
        const branchName = this.getBranchName(version);
        return await this.githubUtilsService.getPRInfo(branchName);
    }

    private getBranchName(version: string): string {
        return `release/${version}`;
    }

    private async createRelease(config: ReleaseConfig, prInfo: PRInfo) {
        const instance = this.getOctokitInstance();
        const context = this.getGitHubContext();

        const releaseBody = this.buildReleaseBody({
            version: config.version,
            description: prInfo.body,
            projectName: config.projectName,
            repoInfo: context.repo,
            prUrl: prInfo.url,
        });

        return await instance.repos.createRelease({
            ...context.repo,
            tag_name: this.getTagName(config.version),
            name: this.getReleaseName(config.version),
            body: releaseBody,
            draft: false,
            prerelease: false,
        });
    }

    private buildReleaseBody(config: ReleaseBody): string {
        const assets = this.getAssetDescriptions(config.projectName, config.version);
        const prLink = config.prUrl ? this.getPRLink(config.prUrl) : '';

        return `## 🚀 New Release v${config.version}

This release includes:

${config.description || 'Release updates and improvements'}

## 📦 Assets

${assets}

${prLink}`;
    }

    private getAssetDescriptions(projectName: string, version: string): string {
        const mtarAsset = `\`${projectName}-v${version}${ASSET_EXTENSIONS.MTAR}\``;
        const zipAsset = `\`${projectName}-v${version}${ASSET_EXTENSIONS.ZIP}\``;

        return `- ${mtarAsset} - Complete package ready for deployment
- ${zipAsset} - Complete package ready for use`;
    }

    private getPRLink(prUrl: string): string {
        return `[🔎 See PR](${prUrl})`;
    }

    private async uploadReleaseAsset(releaseId: number, releaseFilePath: string): Promise<void> {
        if (!releaseId || releaseId <= 0) {
            this.githubUtilsService.logInfo(
                `Invalid release ID: ${releaseId}. Cannot upload asset.`,
            );
            return;
        }

        const asset = this.prepareAsset(releaseFilePath);

        if (!asset.exists) {
            this.githubUtilsService.logInfo(`Asset file not found: ${asset.filePath}`);
            return;
        }

        await this.performAssetUpload(releaseId, asset);
        this.githubUtilsService.logInfo(`Asset uploaded: ${asset.fileName}`);
    }

    private prepareAsset(filePath: string): ReleaseAsset {
        return {
            filePath,
            fileName: path.basename(filePath),
            exists: fs.existsSync(filePath),
        };
    }

    private async performAssetUpload(releaseId: number, asset: ReleaseAsset): Promise<void> {
        const instance = this.getOctokitInstance();
        const context = this.getGitHubContext();
        const assetData = fs.readFileSync(asset.filePath);

        await instance.repos.uploadReleaseAsset({
            ...context.repo,
            release_id: releaseId,
            name: asset.fileName,
            data: assetData,
        });
    }

    private getTagName(version: string): string {
        return `${VERSION_TAG_PREFIX}${version}`;
    }

    private getReleaseName(version: string): string {
        return `${RELEASE_NAME_PREFIX}${version}`;
    }

    private getOctokitInstance() {
        return (this.github as any).getOctokitInstance();
    }

    private getGitHubContext() {
        return (this.github as any).client.context;
    }
}

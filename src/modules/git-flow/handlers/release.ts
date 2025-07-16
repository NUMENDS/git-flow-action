import { GitFlowHandler } from '@/modules/git-flow/protocols';
import { Branches, GitHub } from '@/infra/github/protocols';

import { ChangelogService } from '@/modules/utils/changelog';
import { ProjectManagerService } from '@/modules/utils/project-manager';
import { VersionManagerService } from '@/modules/utils/version-manager';
import { CreateReleaseService, ReleaseConfig } from '@/modules/utils/create-release';
import { GitHubUtilsService } from '@/modules/utils/github';

export class Release implements GitFlowHandler {
    private readonly github: GitHub;
    private readonly changelogService: ChangelogService;
    private readonly projectManager: ProjectManagerService;
    private readonly versionManager: VersionManagerService;
    private readonly createReleaseService: CreateReleaseService;
    private readonly githubUtilsService: GitHubUtilsService;

    constructor(github: GitHub) {
        this.github = github;
        this.changelogService = new ChangelogService(github);
        this.projectManager = new ProjectManagerService(github);
        this.versionManager = new VersionManagerService(github);
        this.createReleaseService = new CreateReleaseService(github);
        this.githubUtilsService = new GitHubUtilsService(github);
    }

    public async test(): Promise<boolean> {
        const branches = await this.github.getBranches();
        const prefixes = this.github.getPrefixes();
        return branches.current.includes(prefixes.release);
    }

    public async handle(): Promise<string> {
        this.githubUtilsService.logInfo('RELEASE HANDLER');
        const branches = await this.github.getBranches();
        const prefixes = this.github.getPrefixes();

        const version = this.versionManager.extractVersionFromBranch(
            branches.current,
            prefixes.release,
        );

        const projectName = this.projectManager.getProjectName();
        this.githubUtilsService.logInfo(`Project name: ${projectName}`);

        await this.versionManager.updateVersionFiles(branches, version);

        await this.changelogService.createOrUpdateChangelog(version, branches.current);

        const sha = await this.merge(branches);

        await this.githubUtilsService.createTag({ branches, prefixes, sha });

        const releaseFilePath = await this.projectManager.buildProject(version, projectName);

        const releaseConfig: ReleaseConfig = {
            version,
            projectName,
            releaseFilePath,
        };
        await this.createReleaseService.createGitHubRelease(releaseConfig);

        // Delete release branch (after everything is done)
        await this.github.delete(branches.current);

        return sha;
    }

    private async merge(branches: Branches): Promise<string> {
        await this.github.merge(branches.current, branches.development);
        const sha = await this.github.merge(branches.current, branches.main);

        return sha;
    }
}

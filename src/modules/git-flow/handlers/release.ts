import { CreateTagParams, GitFlowHandler } from '@/modules/git-flow/protocols';
import { Branches, GitHub } from '@/infra/github/protocols';
import { VersionManagerService } from '@/modules/version-manager';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class Release implements GitFlowHandler {
    private readonly github: GitHub;
    private readonly versionManager: VersionManagerService;
    private releaseFilePath: string = '';

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

        // Extract version from branch name
        const version = this.versionManager.extractVersionFromBranch(
            branches.current,
            prefixes.release,
        );

        // Get project name from package.json
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        let projectName = 'unknown-project';

        if (fs.existsSync(packageJsonPath)) {
            const packageContent = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            projectName = packageContent.name || 'unknown-project';
            this.github.getCore().info(`Project name: ${projectName}`);
        }

        // Update version files
        await this.updateVersionFiles(branches, prefixes);

        // Create or update changelog
        await this.createOrUpdateChangelog(version, branches.current);

        // Merge branches
        const sha = await this.merge(branches);

        // Create tag
        await this.createTag({ branches, prefixes, sha });

        // Build the project
        await this.buildProject(version, projectName, branches);

        // Create GitHub release
        await this.createGitHubRelease(version, projectName);

        // Delete release branch (after everything is done)
        await this.github.delete(branches.current);

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

            // Update mta.yaml if it exists (before building)
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

    private async installDependencies(): Promise<void> {
        const packageLockExists = fs.existsSync(path.join(process.cwd(), 'package-lock.json'));
        const yarnLockExists = fs.existsSync(path.join(process.cwd(), 'yarn.lock'));

        if (packageLockExists) {
            this.github.getCore().info('Found package-lock.json, using npm ci');
            execSync('npm ci', { stdio: 'inherit' });
        } else if (yarnLockExists) {
            this.github.getCore().info('Found yarn.lock, using yarn install --frozen-lockfile');
            execSync('yarn install --frozen-lockfile', { stdio: 'inherit' });
        } else {
            this.github.getCore().info('No lock file found, using npm install');
            execSync('npm install', { stdio: 'inherit' });
        }
    }

    private async runBuild(): Promise<void> {
        const yarnLockExists = fs.existsSync(path.join(process.cwd(), 'yarn.lock'));

        if (yarnLockExists) {
            this.github.getCore().info('Using yarn build');
            execSync('yarn build', { stdio: 'inherit' });
        } else {
            this.github.getCore().info('Using npm run build');
            execSync('npm run build', { stdio: 'inherit' });
        }
    }

    private async buildProject(
        version: string,
        projectName: string,
        branches: Branches,
    ): Promise<void> {
        try {
            this.github.getCore().info(`Building project for version ${version}`);

            // Install dependencies
            this.github.getCore().info('Installing dependencies...');
            await this.installDependencies();

            // Build the project
            this.github.getCore().info('Building project...');
            await this.runBuild();

            // Check if this is an MTA project (has mta.yaml file)
            const mtaYamlExists = fs.existsSync(path.join(process.cwd(), 'mta.yaml'));
            let mtarFilePath = '';
            const isMtaProject = mtaYamlExists;

            if (isMtaProject) {
                this.github.getCore().info('MTA project detected, looking for MTAR file...');

                try {
                    const mtarArchivesPath = path.join(process.cwd(), 'mta_archives');

                    // Check if mta_archives directory exists
                    if (fs.existsSync(mtarArchivesPath)) {
                        // Look for any .mtar file in the directory
                        const mtarFiles = fs.readdirSync(mtarArchivesPath)
                            .filter((file: string) => file.endsWith('.mtar'));

                        if (mtarFiles.length > 0) {
                            this.github.getCore().info('MTAR file found! Processing...');

                            // Use the first .mtar file found
                            const originalMtarFile = path.join(mtarArchivesPath, mtarFiles[0]);
                            const versionedMtarFile = path.join(
                                mtarArchivesPath,
                                `${projectName}-v${version}.mtar`,
                            );

                            // Rename MTAR file to include version
                            fs.renameSync(originalMtarFile, versionedMtarFile);

                            this.github.getCore().info(
                                `Renamed to ${projectName}-v${version}.mtar`,
                            );
                            mtarFilePath = versionedMtarFile;
                        } else {
                            throw new Error(
                                'MTA project detected but no MTAR files found in mta_archives ' +
                                'directory. Build may have failed.',
                            );
                        }
                    } else {
                        throw new Error(
                            'MTA project detected but mta_archives directory not found. ' +
                            'Build may have failed.',
                        );
                    }
                } catch (error) {
                    this.github.getCore().info(`Error processing MTAR file: ${error}`);
                    throw error;
                }
            } else {
                // For non-MTA projects, verify standard build files exist
                this.github.getCore().info('Standard project detected, verifying build files...');
                const buildFile = path.join(process.cwd(), 'lib', 'main', 'index.js');
                if (!fs.existsSync(buildFile)) {
                    throw new Error(
                        'Build files not found after build. Expected lib/main/index.js',
                    );
                }
            }

            // If no MTAR file was processed, create standard package
            if (!mtarFilePath) {
                this.github.getCore().info('Creating standard package...');

                // Create release package (standard GitHub Action)
                const releaseFileName = `${projectName}-v${version}.zip`;
                const filesToPackage = [
                    'lib/',
                    'action.yml',
                    'package.json',
                    'README.md',
                    'LICENSE',
                ];

                // Create zip file with build artifacts
                execSync(`zip -r ${releaseFileName} ${filesToPackage.join(' ')}`,
                    { stdio: 'inherit' });

                this.github.getCore().info(`Build successful! Created ${releaseFileName}`);
                mtarFilePath = releaseFileName;
            }

            // Store the file path for later use in GitHub release
            this.releaseFilePath = mtarFilePath;
        } catch (error) {
            this.github.getCore().info(`Build failed: ${error}`);
            throw error;
        }
    }

    private async createOrUpdateChangelog(version: string, branch: string): Promise<void> {
        try {
            this.github.getCore().info(`Creating/updating changelog for version ${version}`);

            // Get PR information (if available from context)
            const prInfo = await this.getPRInfo(branch);

            // Debug: Log PR info details
            this.github.getCore().info(`PR Info Body length: ${prInfo.body.length}`);
            this.github.getCore().info(`PR Info URL: ${prInfo.url}`);

            // Create new changelog entry
            const newEntry = `# V${version}

This release includes:

${prInfo.body || 'Release updates and improvements'}

${prInfo.url ? `[🔎 See PR](${prInfo.url})` : ''}

---

`;

            // Debug: Log changelog entry
            this.github.getCore().info(`Changelog entry preview: ${newEntry.substring(0, 200)}...`);

            // Get existing changelog content from remote repository
            let existingContent = '';
            try {
                existingContent = await this.github.getFileContent('CHANGELOG.md', branch);
                this.github.getCore().info('Found existing CHANGELOG.md in repository');
            } catch (error) {
                this.github.getCore().info(
                    'CHANGELOG.md not found in repository, creating new one',
                );
                existingContent = '';
            }

            // Create new changelog content
            let newContent = '';
            if (existingContent.includes('# Changelog')) {
                // Replace existing changelog
                const lines = existingContent.split('\n');
                const headerEndIndex = lines.findIndex((line, index) =>
                    index > 0 && line.trim() !== '' && !line.startsWith('#'),
                );
                const header = lines.slice(0, headerEndIndex > 0 ? headerEndIndex : 4).join('\n');
                const existingEntries = lines.slice(
                    headerEndIndex > 0 ? headerEndIndex : 4,
                ).join('\n');
                newContent = `${header}\n\n${newEntry}${existingEntries}`;
            } else {
                // Create new changelog
                newContent = `# Changelog

All notable changes to this project will be documented in this file.

${newEntry}${existingContent}`;
            }

            // Update changelog using GitHub API (same approach as other files)
            try {
                // Get current file SHA for updating (if file exists)
                let fileSha = '';
                try {
                    fileSha = await this.getFileSha('CHANGELOG.md', branch);
                    this.github.getCore().info('Updating existing CHANGELOG.md');
                } catch (error) {
                    this.github.getCore().info('Creating new CHANGELOG.md');
                    // File doesn't exist, fileSha will remain empty for new file creation
                }

                await this.github.updateFile(
                    'CHANGELOG.md',
                    newContent,
                    `docs: update changelog for version ${version}`,
                    branch,
                    fileSha,
                );

                this.github.getCore().info('Changelog committed successfully via GitHub API');
            } catch (commitError) {
                this.github.getCore().info(
                    `Could not commit changelog via GitHub API: ${commitError}. Continuing...`,
                );
                throw commitError;
            }

            this.github.getCore().info('Changelog updated successfully');
        } catch (error) {
            this.github.getCore().info(`Error updating changelog: ${error}`);
            // Don't throw error for changelog issues, continue with release process
            this.github.getCore().info('Continuing with release process...');
        }
    }

    private async createGitHubRelease(version: string, projectName: string): Promise<void> {
        try {
            this.github.getCore().info(`Creating GitHub release for version ${version}`);

            const instance = (this.github as any).getOctokitInstance();
            const context = (this.github as any).client.context;

            // Get PR information
            const prInfo = await this.getPRInfo(`release/${version}`);

            // Create release
            const releaseResponse = await instance.repos.createRelease({
                ...context.repo,
                tag_name: `v${version}`,
                name: `Release v${version}`,
                body: `## 🚀 New Release v${version}

This release includes:

${prInfo.body || 'Release updates and improvements'}

## 📦 Assets

- \`${projectName}-v${version}.mtar\` - Complete package ready for deployment
- \`${projectName}-v${version}.zip\` - Complete package ready for use

## 🔧 Usage

You can use this action in your workflows:

\`\`\`yaml
- name: Run Git Flow
  uses: ${context.repo.owner}/${context.repo.repo}@v${version}
  with:
    github_token: \${{ secrets.GITHUB_TOKEN }}
    master_branch: 'main'
    development_branch: 'development'
\`\`\`

${prInfo.url ? `[🔎 See PR](${prInfo.url})` : ''}`,
                draft: false,
                prerelease: false,
            });

            // Upload release asset
            if (this.releaseFilePath && fs.existsSync(this.releaseFilePath)) {
                const assetData = fs.readFileSync(this.releaseFilePath);
                const fileName = path.basename(this.releaseFilePath);

                await instance.repos.uploadReleaseAsset({
                    ...context.repo,
                    release_id: releaseResponse.data.id,
                    name: fileName,
                    data: assetData,
                });

                this.github.getCore().info(`Asset uploaded: ${fileName}`);
            }

            this.github.getCore().info(
                `GitHub release created successfully: ${releaseResponse.data.html_url}`,
            );
        } catch (error) {
            this.github.getCore().info(`Error creating GitHub release: ${error}`);
            throw error;
        }
    }

    private async getPRInfo(branch: string): Promise<{ body: string; url: string }> {
        const instance = (this.github as any).getOctokitInstance();
        const context = (this.github as any).client.context;

        this.github.getCore().info(`Searching for PR: ${branch}`);

        // Try different branch formats for PR search
        const branchFormats = [
            branch, // e.g., "release/1.0.0"
            branch.replace(/^release\//, ''), // e.g., "1.0.0"
            `${context.repo.owner}:${branch}`, // e.g., "owner:release/1.0.0"
        ];

        for (const branchFormat of branchFormats) {
            try {
                const prs = await instance.pulls.list({
                    ...context.repo,
                    head: branchFormat,
                    state: 'all',
                });

                if (prs.data && prs.data.length > 0) {
                    const pr = prs.data[0];
                    this.github.getCore().info(`✅ Found PR #${pr.number}: ${pr.title}`);

                    // Debug: Log PR details
                    this.github.getCore().info(`PR Body length: ${pr.body?.length || 0}`);
                    const bodyPreview = pr.body?.substring(0, 100) || 'No body content';
                    this.github.getCore().info(`PR Body preview: ${bodyPreview}`);

                    // Get detailed PR information
                    const detailedPr = await instance.pulls.get({
                        ...context.repo,
                        pull_number: pr.number,
                    });

                    const detailedBodyLength = detailedPr.data.body?.length || 0;
                    this.github.getCore().info(`Detailed PR Body length: ${detailedBodyLength}`);

                    // Create enhanced body content
                    let enhancedBody = detailedPr.data.body || pr.body || '';

                    // If no body content, create a meaningful description
                    if (!enhancedBody.trim()) {
                        const title = detailedPr.data.title || pr.title;
                        const changedFiles = detailedPr.data.changed_files || 'Unknown';
                        const commits = detailedPr.data.commits || 'Multiple';
                        enhancedBody = `**${title}**

This release includes changes from PR #${pr.number}.

**Changed files:** ${changedFiles} files modified
**Commits:** ${commits} commits included

For detailed information, please check the pull request.`;
                    }

                    return {
                        body: enhancedBody,
                        url: pr.html_url,
                    };
                }
            } catch (error) {
                this.github.getCore().info(
                    `Error searching with format '${branchFormat}': ${error}`,
                );
                continue;
            }
        }

        // No PR found with any format
        this.github.getCore().info(`❌ No PR found for branch: ${branch}`);
        this.github.getCore().info(`Repository: ${context.repo.owner}/${context.repo.repo}`);
        this.github.getCore().info('Please ensure a Pull Request exists for this release branch');

        throw new Error(`No Pull Request found for release branch '${branch}'`);
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

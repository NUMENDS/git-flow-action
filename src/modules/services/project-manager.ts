import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import { GitHub } from '@/infra/github/protocols';
import { GitHubUtilsService } from '@/modules/services/github';

const DEFAULT_PROJECT_NAME = 'unknown-project';
const PACKAGE_JSON_FILE = 'package.json';
const PACKAGE_LOCK_FILE = 'package-lock.json';
const YARN_LOCK_FILE = 'yarn.lock';
const MTA_YAML_FILE = 'mta.yaml';
const MTA_ARCHIVES_DIR = 'mta_archives';
const MTAR_EXTENSION = '.mtar';
const STANDARD_BUILD_FILE = 'lib/main/index.js';
const ZIP_EXTENSION = '.zip';

export interface ProjectInfo {
    name: string;
    version: string;
    isMtaProject: boolean;
}

export interface BuildResult {
    filePath: string;
    fileName: string;
    projectType: 'mta' | 'standard';
}

export interface PackageManager {
    type: 'npm' | 'yarn';
    hasLockFile: boolean;
    installCommand: string;
    buildCommand: string;
}

export interface ProjectManager {
    getProjectName(): string;
    buildProject(version: string, projectName: string): Promise<string>;
}

export class ProjectManagerService implements ProjectManager {
    private readonly github: GitHub;
    private readonly githubUtilsService: GitHubUtilsService;

    constructor(github: GitHub) {
        this.github = github;
        this.githubUtilsService = new GitHubUtilsService(github);
    }

    public getProjectName(): string {
        try {
            const packageJsonPath = this.getPackageJsonPath();

            if (!this.fileExists(packageJsonPath)) {
                return DEFAULT_PROJECT_NAME;
            }

            const packageContent = this.readJsonFile(packageJsonPath);
            return packageContent.name || DEFAULT_PROJECT_NAME;
        } catch (error) {
            this.githubUtilsService.logInfo(`Error reading project name: ${error}`);
            return DEFAULT_PROJECT_NAME;
        }
    }

    public async buildProject(version: string, projectName: string): Promise<string> {
        try {
            this.githubUtilsService.logInfo(`Building project for version ${version}`);

            await this.prepareBuildEnvironment();
            const projectInfo = this.analyzeProject(version, projectName);
            const buildResult = await this.executeBuild(projectInfo);

            this.githubUtilsService.logInfo(`Build successful! Created ${buildResult.fileName}`);
            return buildResult.filePath;
        } catch (error) {
            this.githubUtilsService.logInfo(`Build failed: ${error}`);
            throw error;
        }
    }

    private async prepareBuildEnvironment(): Promise<void> {
        await this.installDependencies();
        await this.runBuild();
    }

    private analyzeProject(version: string, projectName: string): ProjectInfo {
        const isMtaProject = this.isMtaProject();

        return {
            name: projectName,
            version,
            isMtaProject,
        };
    }

    private async executeBuild(projectInfo: ProjectInfo): Promise<BuildResult> {
        if (projectInfo.isMtaProject) {
            return await this.processMtaBuild(projectInfo);
        }

        return await this.processStandardBuild(projectInfo);
    }

    private async processMtaBuild(projectInfo: ProjectInfo): Promise<BuildResult> {
        this.githubUtilsService.logInfo('MTA project detected, looking for MTAR file...');

        const mtarFilePath = await this.findAndProcessMtarFile(projectInfo);

        return {
            filePath: mtarFilePath,
            fileName: path.basename(mtarFilePath),
            projectType: 'mta',
        };
    }

    private async processStandardBuild(projectInfo: ProjectInfo): Promise<BuildResult> {
        this.githubUtilsService.logInfo('Standard project detected, verifying build files...');

        this.verifyStandardBuildFiles();
        const packageFilePath = this.createStandardPackage(projectInfo);

        return {
            filePath: packageFilePath,
            fileName: path.basename(packageFilePath),
            projectType: 'standard',
        };
    }

    private async findAndProcessMtarFile(projectInfo: ProjectInfo): Promise<string> {
        const mtarArchivesPath = this.getMtarArchivesPath();

        this.validateMtarDirectory(mtarArchivesPath);
        const mtarFiles = this.findMtarFiles(mtarArchivesPath);

        if (mtarFiles.length === 0) {
            throw new Error(
                'MTA project detected but no MTAR files found in mta_archives directory. ' +
                'Build may have failed.',
            );
        }

        return this.renameMtarFile(mtarFiles[0], mtarArchivesPath, projectInfo);
    }

    private renameMtarFile(
        originalFileName: string,
        archivesPath: string,
        projectInfo: ProjectInfo,
    ): string {
        const originalFilePath = path.join(archivesPath, originalFileName);
        const versionedFileName = `${projectInfo.name}-v${projectInfo.version}${MTAR_EXTENSION}`;
        const versionedFilePath = path.join(archivesPath, versionedFileName);

        fs.renameSync(originalFilePath, versionedFilePath);

        this.githubUtilsService.logInfo(`Renamed to ${versionedFileName}`);
        return versionedFilePath;
    }

    private verifyStandardBuildFiles(): void {
        const buildFilePath = path.join(process.cwd(), STANDARD_BUILD_FILE);

        if (!this.fileExists(buildFilePath)) {
            throw new Error(
                `Build files not found after build. Expected ${STANDARD_BUILD_FILE}`,
            );
        }
    }

    private createStandardPackage(projectInfo: ProjectInfo): string {
        this.githubUtilsService.logInfo('Creating standard package...');

        const packageFileName = `${projectInfo.name}-v${projectInfo.version}${ZIP_EXTENSION}`;
        const filesToPackage = this.getStandardPackageFiles();

        this.createZipPackage(packageFileName, filesToPackage);

        return packageFileName;
    }

    private getStandardPackageFiles(): string[] {
        return [
            'lib/',
            'action.yml',
            PACKAGE_JSON_FILE,
            'README.md',
            'LICENSE',
        ];
    }

    private createZipPackage(fileName: string, files: string[]): void {
        const command = `zip -r ${fileName} ${files.join(' ')}`;
        execSync(command, { stdio: 'inherit' });
    }

    private async installDependencies(): Promise<void> {
        this.githubUtilsService.logInfo('Installing dependencies...');

        const packageManager = this.detectPackageManager();
        this.githubUtilsService.logInfo(packageManager.installCommand);

        execSync(packageManager.installCommand, { stdio: 'inherit' });
    }

    private async runBuild(): Promise<void> {
        this.githubUtilsService.logInfo('Building project...');

        const packageManager = this.detectPackageManager();
        this.githubUtilsService.logInfo(packageManager.buildCommand);

        execSync(packageManager.buildCommand, { stdio: 'inherit' });
    }

    private detectPackageManager(): PackageManager {
        const hasPackageLock = this.hasPackageLockFile();
        const hasYarnLock = this.hasYarnLockFile();

        if (hasPackageLock) {
            return {
                type: 'npm',
                hasLockFile: true,
                installCommand: 'npm ci',
                buildCommand: 'npm run build',
            };
        }

        if (hasYarnLock) {
            return {
                type: 'yarn',
                hasLockFile: true,
                installCommand: 'yarn install --frozen-lockfile',
                buildCommand: 'yarn build',
            };
        }

        return {
            type: 'npm',
            hasLockFile: false,
            installCommand: 'npm install',
            buildCommand: 'npm run build',
        };
    }

    // File system utilities
    private getPackageJsonPath(): string {
        return path.join(process.cwd(), PACKAGE_JSON_FILE);
    }

    private getMtarArchivesPath(): string {
        return path.join(process.cwd(), MTA_ARCHIVES_DIR);
    }

    private fileExists(filePath: string): boolean {
        return fs.existsSync(filePath);
    }

    private readJsonFile(filePath: string): any {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    }

    private isMtaProject(): boolean {
        const mtaYamlPath = path.join(process.cwd(), MTA_YAML_FILE);
        return this.fileExists(mtaYamlPath);
    }

    private hasPackageLockFile(): boolean {
        const packageLockPath = path.join(process.cwd(), PACKAGE_LOCK_FILE);
        return this.fileExists(packageLockPath);
    }

    private hasYarnLockFile(): boolean {
        const yarnLockPath = path.join(process.cwd(), YARN_LOCK_FILE);
        return this.fileExists(yarnLockPath);
    }

    private validateMtarDirectory(mtarPath: string): void {
        if (!this.fileExists(mtarPath)) {
            throw new Error(
                'MTA project detected but mta_archives directory not found. ' +
                'Build may have failed.',
            );
        }
    }

    private findMtarFiles(directoryPath: string): string[] {
        return fs.readdirSync(directoryPath)
            .filter((file: string) => file.endsWith(MTAR_EXTENSION));
    }
}

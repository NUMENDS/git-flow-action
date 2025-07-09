export interface VersionManager {
    updatePackageJsonVersion(content: string, version: string): string;
    updateMtaYamlVersion(content: string, version: string): string;
    extractVersionFromBranch(branchName: string, releasePrefix: string): string;
}

export class VersionManagerService implements VersionManager {
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

    public updatePackageJsonVersion(content: string, version: string): string {
        try {
            const packageJson = JSON.parse(content);
            packageJson.version = version;
            return JSON.stringify(packageJson, null, 2);
        } catch (error) {
            throw new Error(`Failed to update package.json version: ${error}`);
        }
    }

    public updateMtaYamlVersion(content: string, version: string): string {
        try {
            // Update version in YAML format
            const versionRegex = /^version:\s*.*/gm;
            return content.replace(versionRegex, `version: ${version}`);
        } catch (error) {
            throw new Error(`Failed to update mta.yaml version: ${error}`);
        }
    }
}

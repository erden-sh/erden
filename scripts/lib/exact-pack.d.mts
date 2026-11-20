export interface ExactPack {
    readonly name: string;
    readonly version: string;
    readonly tarball: string;
}

export declare const packExactVersion: (directory: string, destination: string) => ExactPack;

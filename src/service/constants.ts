// src/service/constants.ts

/**
 * Comprehensive list of directories to exclude from file operations
 * Includes common dependency folders, build outputs, caches, and IDE directories
 */
export const EXCLUDED_DIRS = [
    // Version control
    '.git', '.svn', '.hg',
    // Node.js / JavaScript
    'node_modules', '.npm', '.yarn', '.pnp', '.pnp.js',
    // Python
    '__pycache__', '.pytest_cache', 'venv', 'env', '.venv', '.env',
    '.virtualenv', 'virtualenv', 'site-packages', '.tox', '.eggs',
    '*.egg-info', 'dist', 'build', '.mypy_cache', '.pytype',
    // Java / JVM
    'target', '.gradle', '.m2', 'out', 'build', 'bin', '.mvn',
    // .NET
    'bin', 'obj', 'packages',
    // Ruby
    'vendor', '.bundle',
    // PHP
    'vendor',
    // Go
    'vendor',
    // Rust
    'target',
    // IDE / Editor directories
    '.vscode', '.idea', '.vs', '.vscode-test', '*.swp', '*.swo',
    // OS directories
    '.DS_Store', 'Thumbs.db',
    // Build / Distribution
    'dist', 'build', 'out', 'coverage', '.nyc_output', '.next', '.nuxt',
    // Cache directories
    '.cache', '.parcel-cache', '.turbo', '.vercel', '.netlify',
    // Testing
    '.jest', 'coverage', 'htmlcov', '.coverage',
    // Logs
    'logs', '*.log', 'npm-debug.log*', 'yarn-debug.log*', 'yarn-error.log*',
    // Temporary
    'tmp', 'temp', '.tmp',
    // Gradle wrapper
    'gradle/wrapper'
];

/**
 * Glob pattern for VS Code file searches
 * Used with vscode.workspace.findFiles exclude parameter
 */
// Note: vscode.workspace.findFiles takes an optional exclude glob. A pattern like
//   '{**/node_modules/**,**/.git/**}'
// excludes those folders at ANY depth. The previous single pattern ending with '/**'
// only matched if the folder itself was treated at the root of the glob expansion.
// We generate a robust glob below.

// Directories we want to exclude via glob (filter out entries that contain wildcard '*' because
// those are file name patterns, not directory names). We'll still keep EXCLUDED_DIRS for runtime checks.
const DIR_GLOB_EXCLUDES = EXCLUDED_DIRS.filter(d => !d.includes('*'));

// Build a glob set that matches these directories at any depth: **/dir/**
// Also include direct file artifact patterns we want to exclude (like '*.log') separately.
const FILE_GLOB_EXCLUDES = EXCLUDED_DIRS.filter(d => d.includes('*'));

// Combine into one minimatch set: directories become **/dir/**, files remain as-is.
const allExcludeGlobs = [
    ...DIR_GLOB_EXCLUDES.map(d => `**/${d}/**`),
    ...FILE_GLOB_EXCLUDES
];

// For vscode.workspace.findFiles we can pass a single brace expansion pattern.
export const EXCLUDED_GLOB_PATTERN = `{${allExcludeGlobs.join(',')}}`;

// Also export the expanded array for any APIs that accept an array.
export const EXCLUDED_GLOB_ARRAY = allExcludeGlobs;
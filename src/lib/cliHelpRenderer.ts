/**
 * CLI help text renderer for the Iranti CLI.
 *
 * Consumes structured help catalog data and renders it to stdout using a
 * caller-supplied CliHelpStyle object that decouples colour (chalk for TTY)
 * from plain-text rendering (tests, pipes). Each public print* function
 * corresponds to one CLI command's `--help` output.
 *
 * Separation of concerns:
 *   - This module: rendering layout (sections, indentation, field labels)
 *   - cliHelpCatalog: text content (commands, descriptions, use-when text)
 *   - CLI entry point: the CliHelpStyle object (chalk vs. plain)
 *
 * Key exports:
 *   - printMainHelp()    — top-level iranti --help
 *   - printSetupHelp()   — iranti setup --help
 *   - print*Help()       — one print function per command
 *   - printWizardNotes() — bulleted wizard note block
 *   - printChoiceGuide() — interactive choice guidance block
 */

import {
    AUTH_HELP,
    COMMON_FLOWS,
    CONFIGURATION_HELP,
    CONFIGURE_HELP,
    CONNECT_HELP,
    DIAGNOSTICS_HELP,
    HelpEntry,
    INSTANCE_HELP,
    INTEGRATE_HELP,
    INTEGRATIONS_HELP,
    KEY_HELP,
    OptionGuideEntry,
    PROVIDER_KEY_HELP,
    SETUP_AND_RUNTIME_HELP,
    SETUP_COMMAND_HELP,
    SETUP_OPTION_GUIDE,
    START_HERE_HELP,
    UNINSTALL_HELP,
    UNINSTALL_OPTION_GUIDE,
} from './cliHelpCatalog';

type ChoiceGuideEntry = {
    choice: string;
    meaning: string;
    useWhen: string;
};

export type CliHelpStyle = {
    sectionTitle: (text: string) => string;
    commandText: (text: string) => string;
};

function printHelpEntries(style: CliHelpStyle, title: string, entries: HelpEntry[]): void {
    console.log(style.sectionTitle(title));
    for (const entry of entries) {
        console.log(`  ${style.commandText(entry.command)}`);
        console.log(`    What it does: ${entry.description}`);
        if (entry.useWhen) {
            console.log(`    Use this when: ${entry.useWhen}`);
        }
        if (entry.scenario) {
            console.log(`    Typical scenario: ${entry.scenario}`);
        }
    }
    console.log('');
}

function printSingleHelpEntry(style: CliHelpStyle, title: string, entry: HelpEntry): void {
    printHelpEntries(style, title, [entry]);
}

function requireHelpEntry(entries: HelpEntry[], prefix: string): HelpEntry {
    const match = entries.find((entry) => entry.command.startsWith(prefix));
    if (!match) {
        throw new Error(`Missing CLI help entry for prefix: ${prefix}`);
    }
    return match;
}

function printOptionGuide(style: CliHelpStyle, title: string, entries: OptionGuideEntry[]): void {
    console.log(style.sectionTitle(title));
    for (const entry of entries) {
        console.log(`  ${style.commandText(entry.option)}`);
        console.log(`    What it means: ${entry.meaning}`);
        console.log(`    Use this when: ${entry.useWhen}`);
    }
    console.log('');
}

function printChoiceGuide(style: CliHelpStyle, title: string, entries: ChoiceGuideEntry[]): void {
    console.log(style.sectionTitle(title));
    for (const entry of entries) {
        console.log(`  ${style.commandText(entry.choice)}`);
        console.log(`    What it means: ${entry.meaning}`);
        console.log(`    Use this when: ${entry.useWhen}`);
    }
    console.log('');
}

export function printWizardNotes(style: CliHelpStyle, title: string, lines: string[]): void {
    console.log(style.sectionTitle(title));
    for (const line of lines) {
        console.log(`  - ${line}`);
    }
    console.log('');
}

export function printMainHelp(style: CliHelpStyle): void {
    console.log(style.sectionTitle('Iranti CLI'));
    console.log('Memory infrastructure for multi-agent systems.');
    console.log('Most instance-aware commands also accept --root <path> in addition to --scope.');
    console.log('On Windows cmd.exe, use no quotes or double quotes around --root paths. Single quotes are treated literally there.');
    console.log('Global debugging flags: --debug for extra diagnostics, --verbose for subprocess trace output.');
    console.log('');

    console.log('Run `iranti <command> --help` when you want the flag-by-flag version of this guidance.');
    console.log('');

    printHelpEntries(style, 'Start Here', START_HERE_HELP);
    printHelpEntries(style, 'Setup And Runtime', SETUP_AND_RUNTIME_HELP);
    printHelpEntries(style, 'Configuration', CONFIGURATION_HELP);
    printHelpEntries(style, 'Keys', KEY_HELP);
    printHelpEntries(style, 'Diagnostics And Operator Tools', DIAGNOSTICS_HELP);
    printHelpEntries(style, 'Cloud Connect', CONNECT_HELP);
    printHelpEntries(style, 'Integrations', INTEGRATIONS_HELP);

    console.log(style.sectionTitle('Common Flows'));
    console.log(`  ${style.commandText('First install')}`);
    for (const command of COMMON_FLOWS.firstInstall) {
        console.log(`    ${style.commandText(command)}`);
    }
    console.log('');
    console.log(`  ${style.commandText('Bind a project')}`);
    for (const command of COMMON_FLOWS.bindProject) {
        console.log(`    ${style.commandText(command)}`);
    }
    console.log('');
    console.log(`  ${style.commandText('Work with keys')}`);
    for (const command of COMMON_FLOWS.workWithKeys) {
        console.log(`    ${style.commandText(command)}`);
    }
}

export function printSetupHelp(style: CliHelpStyle): void {
    printHelpEntries(style, 'Setup Command', SETUP_COMMAND_HELP);
    printOptionGuide(style, 'Setup Option Guide', SETUP_OPTION_GUIDE);
}

export function printInstallHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Install Command',
        requireHelpEntry(SETUP_AND_RUNTIME_HELP, 'iranti install ')
    );
}

export function printRunHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Run Command',
        requireHelpEntry(SETUP_AND_RUNTIME_HELP, 'iranti run ')
    );
}

export function printUninstallHelp(style: CliHelpStyle): void {
    printHelpEntries(style, 'Uninstall Command', UNINSTALL_HELP);
    printOptionGuide(style, 'Uninstall Option Guide', UNINSTALL_OPTION_GUIDE);
}

export function printInstanceHelp(style: CliHelpStyle): void {
    printHelpEntries(style, 'Instance Commands', INSTANCE_HELP);
}

export function printConfigureHelp(style: CliHelpStyle): void {
    printHelpEntries(style, 'Configure Commands', CONFIGURE_HELP);
}

export function printConfigureInstanceHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Configure Instance Command',
        requireHelpEntry(CONFIGURE_HELP, 'iranti configure instance ')
    );
}

export function printConfigureProjectHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Configure Project Command',
        requireHelpEntry(CONFIGURE_HELP, 'iranti configure project ')
    );
}

export function printAuthHelp(style: CliHelpStyle): void {
    printHelpEntries(style, 'Auth Commands', AUTH_HELP);
}

export function printAuthCreateKeyHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Auth Create-Key Command',
        requireHelpEntry(AUTH_HELP, 'iranti auth create-key ')
    );
}

export function printAuthListKeysHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Auth List-Keys Command',
        requireHelpEntry(AUTH_HELP, 'iranti auth list-keys ')
    );
}

export function printAuthRevokeKeyHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Auth Revoke-Key Command',
        requireHelpEntry(AUTH_HELP, 'iranti auth revoke-key ')
    );
}

export function printIntegrateHelp(style: CliHelpStyle): void {
    printHelpEntries(style, 'Integrations', INTEGRATE_HELP);
}

export function printConnectHelp(style: CliHelpStyle): void {
    printHelpEntries(style, 'Connect Command', CONNECT_HELP);
}

export function printProjectInitHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Project Init Command',
        requireHelpEntry(CONFIGURATION_HELP, 'iranti project init ')
    );
}

export function printProjectUnbindHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Project Unbind Command',
        requireHelpEntry(CONFIGURATION_HELP, 'iranti project unbind ')
    );
}

export function printDoctorHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Doctor Command',
        requireHelpEntry(DIAGNOSTICS_HELP, 'iranti doctor ')
    );
    console.log('  Windows cmd.exe note: write `--root C:\\path\\to\\runtime` or `--root "C:\\path\\to\\runtime"`. Do not wrap --root in single quotes there.');
}

export function printStatusHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Status Command',
        requireHelpEntry(DIAGNOSTICS_HELP, 'iranti status ')
    );
    console.log('  Windows cmd.exe note: write `--root C:\\path\\to\\runtime` or `--root "C:\\path\\to\\runtime"`. Do not wrap --root in single quotes there.');
}

export function printUpgradeHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Upgrade Command',
        requireHelpEntry(DIAGNOSTICS_HELP, 'iranti upgrade ')
    );
}

export function printHandshakeHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Handshake Command',
        requireHelpEntry(DIAGNOSTICS_HELP, 'iranti handshake ')
    );
}

export function printAttendHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Attend Command',
        requireHelpEntry(DIAGNOSTICS_HELP, 'iranti attend ')
    );
}

export function printIssuesHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Issues Command',
        requireHelpEntry(DIAGNOSTICS_HELP, 'iranti issues ')
    );
}

export function printHandoffHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Handoff Command',
        requireHelpEntry(DIAGNOSTICS_HELP, 'iranti handoff ')
    );
}

export function printChatHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Chat Command',
        requireHelpEntry(DIAGNOSTICS_HELP, 'iranti chat ')
    );
}

export function printResolveHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Resolve Command',
        requireHelpEntry(DIAGNOSTICS_HELP, 'iranti resolve ')
    );
}

export function printProviderKeyHelp(style: CliHelpStyle): void {
    printHelpEntries(style, 'Provider Key Commands', PROVIDER_KEY_HELP);
    console.log('  Target either an instance env or a project binding. If neither is supplied, the CLI will try the current project first.');
    console.log('  Use instance targeting for shared runtime configuration. Use project targeting when the command should follow a specific `.env.iranti` binding.');
}

export function printFeedbackHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'Feedback Command',
        requireHelpEntry(DIAGNOSTICS_HELP, 'iranti feedback ')
    );
}

export function printUiHelp(style: CliHelpStyle): void {
    printSingleHelpEntry(
        style,
        'UI Command',
        requireHelpEntry(DIAGNOSTICS_HELP, 'iranti ui ')
    );
}

export { printChoiceGuide };

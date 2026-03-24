import {
    AUTH_HELP,
    COMMON_FLOWS,
    CONFIGURATION_HELP,
    CONFIGURE_HELP,
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
    console.log('Global debugging flags: --debug for extra diagnostics, --verbose for subprocess trace output.');
    console.log('');

    console.log('Run `iranti <command> --help` when you want the flag-by-flag version of this guidance.');
    console.log('');

    printHelpEntries(style, 'Start Here', START_HERE_HELP);
    printHelpEntries(style, 'Setup And Runtime', SETUP_AND_RUNTIME_HELP);
    printHelpEntries(style, 'Configuration', CONFIGURATION_HELP);
    printHelpEntries(style, 'Keys', KEY_HELP);
    printHelpEntries(style, 'Diagnostics And Operator Tools', DIAGNOSTICS_HELP);
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

export function printAuthHelp(style: CliHelpStyle): void {
    printHelpEntries(style, 'Auth Commands', AUTH_HELP);
}

export function printIntegrateHelp(style: CliHelpStyle): void {
    printHelpEntries(style, 'Integrations', INTEGRATE_HELP);
}

export function printProviderKeyHelp(style: CliHelpStyle): void {
    printHelpEntries(style, 'Provider Key Commands', PROVIDER_KEY_HELP);
    console.log('  Target either an instance env or a project binding. If neither is supplied, the CLI will try the current project first.');
    console.log('  Use instance targeting for shared runtime configuration. Use project targeting when the command should follow a specific `.env.iranti` binding.');
}

export { printChoiceGuide };

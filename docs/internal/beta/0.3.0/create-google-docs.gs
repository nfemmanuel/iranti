/**
 * Iranti Closed Beta v0.3.0 — Tester Guide Google Doc
 *
 * Creates a self-contained onboarding document for beta testers:
 *   - What is Iranti
 *   - Prerequisites
 *   - Step-by-step setup
 *   - Connecting your host (Claude Code / Codex)
 *   - What to test and look for
 *   - Checklist
 *   - How to report issues
 *   - Contact info
 *
 * How to use:
 * 1. Go to https://script.google.com
 * 2. Create a new project (or add to the existing one)
 * 3. Paste this entire file into Code.gs
 * 4. Click Run → createTesterGuide
 * 5. Authorize when prompted (it needs Docs permission)
 * 6. Check the logs (View → Logs) for the document URL
 */

var FONT = 'Helvetica Neue';

function createTesterGuide() {
  var doc = DocumentApp.create('Iranti Closed Beta v0.3.0 — Tester Guide');
  var body = doc.getBody();

  // ── Styles ──
  var titleStyle = {};
  titleStyle[DocumentApp.Attribute.FONT_SIZE] = 24;
  titleStyle[DocumentApp.Attribute.BOLD] = true;
  titleStyle[DocumentApp.Attribute.FONT_FAMILY] = FONT;

  var subtitleStyle = {};
  subtitleStyle[DocumentApp.Attribute.FONT_SIZE] = 13;
  subtitleStyle[DocumentApp.Attribute.BOLD] = false;
  subtitleStyle[DocumentApp.Attribute.ITALIC] = true;
  subtitleStyle[DocumentApp.Attribute.FONT_FAMILY] = FONT;
  subtitleStyle[DocumentApp.Attribute.FOREGROUND_COLOR] = '#666666';

  var h2Style = {};
  h2Style[DocumentApp.Attribute.FONT_SIZE] = 17;
  h2Style[DocumentApp.Attribute.BOLD] = true;
  h2Style[DocumentApp.Attribute.FONT_FAMILY] = FONT;

  var h3Style = {};
  h3Style[DocumentApp.Attribute.FONT_SIZE] = 13;
  h3Style[DocumentApp.Attribute.BOLD] = true;
  h3Style[DocumentApp.Attribute.FONT_FAMILY] = FONT;

  var normalStyle = {};
  normalStyle[DocumentApp.Attribute.FONT_SIZE] = 11;
  normalStyle[DocumentApp.Attribute.BOLD] = false;
  normalStyle[DocumentApp.Attribute.ITALIC] = false;
  normalStyle[DocumentApp.Attribute.FONT_FAMILY] = FONT;

  var codeStyle = {};
  codeStyle[DocumentApp.Attribute.FONT_SIZE] = 10;
  codeStyle[DocumentApp.Attribute.BOLD] = false;
  codeStyle[DocumentApp.Attribute.FONT_FAMILY] = 'Roboto Mono';
  codeStyle[DocumentApp.Attribute.BACKGROUND_COLOR] = '#f5f5f5';

  var noteStyle = {};
  noteStyle[DocumentApp.Attribute.FONT_SIZE] = 10;
  noteStyle[DocumentApp.Attribute.BOLD] = false;
  noteStyle[DocumentApp.Attribute.ITALIC] = true;
  noteStyle[DocumentApp.Attribute.FONT_FAMILY] = FONT;
  noteStyle[DocumentApp.Attribute.FOREGROUND_COLOR] = '#555555';

  // Helper to add a section heading
  function addH2(text) {
    var h = body.appendParagraph(text);
    h.setAttributes(h2Style);
    h.setSpacingBefore(20);
    h.setSpacingAfter(6);
    return h;
  }

  function addH3(text) {
    var h = body.appendParagraph(text);
    h.setAttributes(h3Style);
    h.setSpacingBefore(14);
    h.setSpacingAfter(4);
    return h;
  }

  function addPara(text) {
    var p = body.appendParagraph(text);
    p.setAttributes(normalStyle);
    p.setSpacingAfter(4);
    return p;
  }

  function addCode(text) {
    var p = body.appendParagraph(text);
    p.setAttributes(codeStyle);
    p.setSpacingAfter(4);
    return p;
  }

  function addNote(text) {
    var p = body.appendParagraph(text);
    p.setAttributes(noteStyle);
    p.setSpacingAfter(4);
    return p;
  }

  function addBullet(text) {
    var item = body.appendListItem(text);
    item.setGlyphType(DocumentApp.GlyphType.BULLET);
    item.setAttributes(normalStyle);
    return item;
  }

  function addCheckbox(text) {
    var item = body.appendListItem(text);
    item.setGlyphType(DocumentApp.GlyphType.HOLLOW_BULLET);
    item.setAttributes(normalStyle);
    return item;
  }

  function addNumbered(text) {
    var item = body.appendListItem(text);
    item.setGlyphType(DocumentApp.GlyphType.NUMBER);
    item.setAttributes(normalStyle);
    return item;
  }

  // ═══════════════════════════════════════════
  // TITLE
  // ═══════════════════════════════════════════

  body.clear();
  var title = body.appendParagraph('Iranti Closed Beta v0.3.0');
  title.setAttributes(titleStyle);
  title.setSpacingAfter(2);

  var subtitle = body.appendParagraph('Tester Guide');
  subtitle.setAttributes(subtitleStyle);
  subtitle.setSpacingAfter(16);

  // ═══════════════════════════════════════════
  // WHAT IS IRANTI
  // ═══════════════════════════════════════════

  addH2('What is Iranti?');

  addPara(
    'Iranti is memory infrastructure for AI workflows. It gives your AI tools ' +
    'persistent, shared memory that survives across sessions, context windows, ' +
    'and even across different tools and agents.'
  );

  addPara(
    'If you\u2019ve ever had to re-explain your project, your preferences, or what ' +
    'you were working on every time you start a new session with Claude Code, Codex, ' +
    'Cursor, or any other AI tool \u2014 that\u2019s the problem Iranti solves.'
  );

  addPara('With Iranti, your AI tools can:');
  addBullet('Remember what you were working on and resume where you left off');
  addBullet('Share context between different tools (e.g. Claude Code and Codex)');
  addBullet('Recall project decisions, facts, and preferences across sessions');
  addBullet('Detect and resolve conflicting information automatically');

  addNote(
    'Iranti is not a chatbot or an AI model. It\u2019s a memory layer that sits ' +
    'behind the AI tools you already use.'
  );

  // ═══════════════════════════════════════════
  // WHAT WE\u2019RE TESTING
  // ═══════════════════════════════════════════

  addH2('What We\u2019re Testing');

  addPara(
    'This beta is focused on one question: does Iranti materially reduce ' +
    'rediscovery across sessions, hosts, and agent handoffs for real coding work?'
  );

  addPara(
    'We\u2019re not looking for polished-demo feedback. We want honest signal on ' +
    'whether it\u2019s actually useful and trustworthy in real workflows.'
  );

  // ═══════════════════════════════════════════
  // PREREQUISITES
  // ═══════════════════════════════════════════

  addH2('Prerequisites');

  addBullet('Node.js 18 or later');
  addBullet('Docker (recommended) or a PostgreSQL instance with pgvector');
  addBullet('One of: Claude Code, Codex, or another MCP-compatible AI tool');
  addBullet('A real project you\u2019re actively working on');

  // ═══════════════════════════════════════════
  // SETUP
  // ═══════════════════════════════════════════

  addH2('Setup');

  addH3('Step 1: Install Iranti');
  addCode('npm install -g iranti');

  addH3('Step 2: Run Guided Setup');
  addCode('iranti setup');

  addPara(
    'This walks you through creating an instance, configuring PostgreSQL, ' +
    'setting up your LLM provider credentials, and generating an API key. ' +
    'If Docker is available, setup will use it automatically for PostgreSQL.'
  );

  addNote('For a faster setup with defaults: iranti setup --defaults');

  addH3('Step 3: Start the Instance');
  addCode('iranti run --instance local');

  addPara('In another terminal, verify everything is healthy:');
  addCode('iranti doctor --instance local');

  addPara('You should see all checks passing (or only minor warnings).');

  addH3('Step 4: Bind Your Project');
  addPara('Navigate to the project you want to test with and run:');
  addCode('cd /path/to/your/project');
  addCode('iranti project init . --instance local --agent-id my_agent');

  addPara(
    'This creates an .env.iranti file in your project that connects it to your Iranti instance.'
  );

  addH3('Step 5: Connect Your AI Tool');

  addPara('For Claude Code:');
  addCode('iranti claude-setup');

  addPara('For Codex:');
  addCode('iranti codex-setup');

  addPara(
    'These commands wire your project to Iranti\u2019s MCP tools so your AI tool ' +
    'can read and write memory automatically.'
  );

  addH3('Step 6: Verify');
  addPara('You should now have:');
  addBullet('A running instance visible in iranti status');
  addBullet('A bound project with an .env.iranti file');
  addBullet('MCP tools available in your AI tool (ask it to list MCP tools to confirm)');

  addNote(
    'If something goes wrong at any step, run iranti doctor --debug for diagnostics. ' +
    'If host tools don\u2019t appear, rerun iranti claude-setup or iranti codex-setup ' +
    'from the bound project directory.'
  );

  // ═══════════════════════════════════════════
  // HOW TO USE IRANTI
  // ═══════════════════════════════════════════

  addH2('How to Use Iranti');

  addPara(
    'Once setup is complete, Iranti works in the background. Your AI tool will ' +
    'automatically read from and write to shared memory as you work. You don\u2019t ' +
    'need to do anything special \u2014 just use your AI tool normally on a real task.'
  );

  addPara('The key things that happen automatically:');
  addBullet('At session start, your tool loads relevant memory from previous sessions');
  addBullet('During work, important facts and decisions are written to memory');
  addBullet('At checkpoints, progress is saved so the next session can resume');
  addBullet('Across tools, memory written by one tool is readable by another');

  addPara(
    'The real test is what happens when you come back later, or switch tools. ' +
    'Does the AI remember what you were doing? Does it pick up where you left off?'
  );

  // ═══════════════════════════════════════════
  // TESTING CHECKLIST
  // ═══════════════════════════════════════════

  addH2('Testing Checklist');

  addPara('Work through these over the course of your beta period:');

  addCheckbox('Complete setup and connect to your AI tool');
  addCheckbox('Use Iranti on a real project or real problem (not a toy prompt)');
  addCheckbox('Use it across at least 2\u20133 separate sessions');
  addCheckbox('If possible, test across more than one day');
  addCheckbox('If possible, test across more than one host or tool');
  addCheckbox('Try at least one \u201Cresume previous work\u201D scenario');
  addCheckbox('Try at least one \u201Chandoff between tools\u201D scenario (if applicable)');
  addCheckbox('Notice whether Iranti reduces repeated re-explaining');
  addCheckbox('Write down any setup friction as soon as it happens');
  addCheckbox('Report any case where memory is wrong, missing, stale, or misleading');
  addCheckbox('Pay attention to whether it\u2019s clear when Iranti writes, recalls, and what it remembers');
  addCheckbox('Complete the feedback form after your final session');

  // ═══════════════════════════════════════════
  // WHAT TO LOOK FOR
  // ═══════════════════════════════════════════

  addH2('What to Look For');

  addPara('As you test, evaluate Iranti on these dimensions:');

  addH3('Setup Clarity');
  addPara('Was installation straightforward? Were error messages helpful? Did you get stuck?');

  addH3('Trust and Reliability');
  addPara(
    'When Iranti surfaces memory, is it accurate? Do you trust what it tells your AI tool? ' +
    'Does it ever inject incorrect, outdated, or irrelevant information?'
  );

  addH3('Cross-Session Continuity');
  addPara(
    'When you start a new session on the same project, does the AI pick up where ' +
    'you left off? How much re-explaining do you still have to do?'
  );

  addH3('Cross-Tool Continuity');
  addPara(
    'If you use more than one tool (e.g. Claude Code and Codex), can one tool see ' +
    'what you did with the other? Does the handoff feel useful?'
  );

  addH3('Failure Behavior');
  addPara(
    'If Iranti has a problem (can\u2019t connect, returns an error), does your AI tool ' +
    'still work? Does it degrade gracefully or does it break your workflow?'
  );

  addH3('Overall Value');
  addPara(
    'After using it for a few days: would you keep Iranti on? Does it save you enough ' +
    'time and friction to justify having it in your workflow?'
  );

  // ═══════════════════════════════════════════
  // MINIMUM USEFUL RUN
  // ═══════════════════════════════════════════

  addH2('Minimum Useful Beta Run');

  addPara('If you\u2019re short on time, the minimum useful test is:');

  addNumbered('One setup session');
  addNumbered('One real work session');
  addNumbered('One later resume session (come back and continue)');
  addNumbered('Complete the feedback form');

  addNote('Anything less mostly tests onboarding, not continuity \u2014 and continuity is what we\u2019re validating.');

  // ═══════════════════════════════════════════
  // REPORTING ISSUES
  // ═══════════════════════════════════════════

  addH2('Reporting Issues');

  addPara('If you hit a problem during the beta, try to capture:');

  addBullet('What host/tool you were using');
  addBullet('What you expected Iranti to remember');
  addBullet('What it actually returned (or failed to return)');
  addBullet('Whether the issue was setup-related, recall-related, trust-related, or host-integration-related');
  addBullet('Screenshots or terminal output if possible');

  addPara(
    'You can include this in the feedback form, or send it directly to the email below.'
  );

  // ═══════════════════════════════════════════
  // QUESTIONS & CONTACT
  // ═══════════════════════════════════════════

  addH2('Questions?');

  addPara(
    'If you get stuck at any point during setup or testing, or if you have any ' +
    'questions about the beta, reach out:'
  );

  var emailPara = body.appendParagraph('niimanuel417@gmail.com');
  emailPara.setAttributes(normalStyle);
  emailPara.setLinkUrl('mailto:niimanuel417@gmail.com');
  emailPara.setBold(true);
  emailPara.setSpacingBefore(8);
  emailPara.setSpacingAfter(8);

  addPara('Thanks for testing Iranti. Your feedback directly shapes what ships next.');

  doc.saveAndClose();
  Logger.log('Tester Guide created: ' + doc.getUrl());
}

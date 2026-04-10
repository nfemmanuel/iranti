/**
 * Iranti Closed Beta v0.3.0 — Google Form Generator
 *
 * How to use:
 * 1. Go to https://script.google.com
 * 2. Create a new project
 * 3. Paste this entire file into Code.gs
 * 4. Click Run → createIrantiBetaForm
 * 5. Authorize when prompted (it needs Forms permission)
 * 6. Check the logs (View → Logs) for the form URL
 */

function createIrantiBetaForm() {
  var form = FormApp.create('Iranti Closed Beta Feedback');
  form.setDescription(
    'Thanks for testing Iranti. This beta is focused on real-world memory across ' +
    'sessions, tools, and agents. Please use Iranti on an actual task over multiple ' +
    'sessions, then complete this form as honestly and specifically as you can.'
  );
  form.setIsQuiz(false);
  form.setAllowResponseEdits(true);
  form.setCollectEmail(false);
  form.setProgressBar(true);

  // ── Section 1: Tester Profile ──

  form.addPageBreakItem()
    .setTitle('Tester Profile');

  form.addTextItem()
    .setTitle('Full name')
    .setRequired(true);

  form.addTextItem()
    .setTitle('Email address')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('What kind of work do you do?')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Which AI tools do you actively use?')
    .setHelpText('Examples: Claude Code, Codex, Cursor, ChatGPT, custom agents, scripts')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How often do you work across multiple AI sessions on the same task?')
    .setChoiceValues(['Daily', 'Several times a week', 'Weekly', 'Rarely'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How often do you lose useful context between sessions or tools?')
    .setChoiceValues(['Very often', 'Often', 'Sometimes', 'Rarely', 'Never'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Have you used any memory layer or project-memory system for AI workflows before?')
    .setChoiceValues(['Yes', 'No'])
    .setRequired(true);

  // ── Section 2: Test Context ──

  form.addPageBreakItem()
    .setTitle('Test Context');

  form.addParagraphTextItem()
    .setTitle('What project or workflow did you test Iranti on?')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('What operating system did you use?')
    .setChoiceValues(['macOS', 'Windows', 'Linux'])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('Which host(s) or tool(s) did you use with Iranti during the beta?')
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Over how many days did you use Iranti?')
    .setChoiceValues(['1 day', '2-3 days', '4-5 days', '6-7 days', 'More than 7 days'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Across how many separate sessions did you use Iranti?')
    .setChoiceValues(['1', '2', '3', '4-5', '6+'])
    .setRequired(true);

  // ── Section 3: Experience ──

  form.addPageBreakItem()
    .setTitle('Experience');

  form.addMultipleChoiceItem()
    .setTitle('How easy was setup?')
    .setChoiceValues(['Very easy', 'Mostly easy', 'Mixed', 'Difficult', 'Very difficult'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How clear was it what Iranti was doing?')
    .setChoiceValues(['Very clear', 'Mostly clear', 'Mixed', 'Confusing', 'Very confusing'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Did Iranti help you resume work across sessions?')
    .setChoiceValues(['Yes clearly', 'Somewhat', 'Not really', 'No'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Did Iranti help across tools or agents?')
    .setChoiceValues(['Yes clearly', 'Somewhat', 'Not really', 'No', 'Did not test'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('How reliable did Iranti feel overall?')
    .setChoiceValues(['Very reliable', 'Mostly reliable', 'Mixed', 'Unreliable'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Did Iranti reduce repeated re-explaining or re-discovery?')
    .setChoiceValues(['Yes a lot', 'Somewhat', 'Not much', 'No'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Did you encounter any incorrect, missing, duplicated, stale, or misleading memory behavior?')
    .setChoiceValues(['Yes', 'No'])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('If yes, describe the issue as specifically as possible.')
    .setRequired(false);

  form.addParagraphTextItem()
    .setTitle('What worked best?')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('What was most frustrating or confusing?')
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('What is the single biggest improvement you want before wider release?')
    .setRequired(true);

  // ── Section 4: Outcome ──

  form.addPageBreakItem()
    .setTitle('Outcome');

  form.addMultipleChoiceItem()
    .setTitle('Would you keep using Iranti if it were available today?')
    .setChoiceValues(['Yes', 'Maybe', 'No'])
    .setRequired(true);

  form.addMultipleChoiceItem()
    .setTitle('Would you recommend it to someone with your workflow?')
    .setChoiceValues(['Yes', 'Maybe', 'No'])
    .setRequired(true);

  form.addParagraphTextItem()
    .setTitle('What would need to improve before you would recommend it?')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle('Are you open to a short follow-up conversation?')
    .setChoiceValues(['Yes', 'No'])
    .setRequired(true);

  // ── Done ──

  Logger.log('Form created: ' + form.getEditUrl());
  Logger.log('Shareable link: ' + form.getPublishedUrl());
  Logger.log('Short URL: ' + form.shortenFormUrl(form.getPublishedUrl()));
}

# QA Guideline (pi Package)

## Scope

Behavioral correctness of the pi package extensions, skills, prompts, and themes.
Type checking, linting, and other code quality checks are out of scope (handled by gatecheck).

## Local Package Installation

### Install for Testing

```bash
# Install locally to test
pi install /absolute/path/to/pi-ralph

# Or try temporarily without persisting
pi -e /absolute/path/to/pi-ralph
```

### Verification Flow

1. Install the package locally in pi
2. Verify extensions load without errors
3. Exercise extension commands/tools
4. Verify skills appear and produce correct behavior
5. Verify prompts and themes load correctly
6. Uninstall when done: `pi remove /absolute/path/to/pi-ralph`

### Verification Checklist

- [ ] Package installs without errors via `pi install`
- [ ] All extensions register and load successfully
- [ ] Extension commands execute with expected behavior
- [ ] Skills are discoverable and produce correct instructions
- [ ] Error cases are handled gracefully
- [ ] Package uninstalls cleanly

## Automated Test Coverage

1. Identify existing tests related to the target code
2. Review test case coverage — pay special attention to error cases, boundary values, and semi-normal scenarios
3. If gaps are found, implement additional tests
4. Run all relevant tests and confirm they pass

## Exploratory Testing Notes

- pi packages are loaded at agent startup; restart pi after install/remove
- Use `pi list` to verify package is installed
- Extensions may have side effects; test in isolation when possible

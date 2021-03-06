import ts = require("typescript");

function isMethodCall(
  el: ts.Declaration,
  methodName: string,
): el is ts.VariableDeclaration {
  return (
    ts.isVariableDeclaration(el) &&
    !!el.initializer &&
    ts.isCallExpression(el.initializer) &&
    el.initializer.expression &&
    ts.isIdentifier(el.initializer.expression) &&
    el.initializer.expression.text === methodName
  );
}

/**
 * Represents a react-intl message descriptor
 */
export interface Message {
  defaultMessage: string;
  description?: string;
  id: string;
}

// This is the only JSX element we can extract messages from:
type ElementName = "FormattedMessage" | string;
// These are the two methods we can extract messages from:
type MethodName = "defineMessages" | "formatMessage";
// MessageExtracter defines a function type which can extract zero or more
// valid Messages from an ObjectLiteralExpression:
type MessageExtracter = (obj: ts.ObjectLiteralExpression) => Message[];

// sets `target[key] = value`, but only if it is a legal Message key
function copyIfMessageKey(
  target: Partial<Message>,
  key: string,
  value: string,
) {
  switch (key) {
    case "defaultMessage":
    case "description":
    case "id":
      target[key] = value;
      break;
    default:
      break;
  }
}

// are the required keys of a valid Message present?
function isValidMessage(obj: Partial<Message>): obj is Message {
  return "id" in obj && "defaultMessage" in obj;
}

function extractMessagesForDefineMessages(
  objLiteral: ts.ObjectLiteralExpression,
): Message[] {
  const messages: Message[] = [];
  objLiteral.properties.forEach((p) => {
    const msg: Partial<Message> = {};
    if (
      ts.isPropertyAssignment(p) &&
      ts.isObjectLiteralExpression(p.initializer) &&
      p.initializer.properties
    ) {
      p.initializer.properties.forEach((ip) => {
        if (
          ip.name &&
          (ts.isIdentifier(ip.name) || ts.isLiteralExpression(ip.name))
        ) {
          const name = ip.name.text;
          if (
            ts.isPropertyAssignment(ip) &&
            (ts.isStringLiteral(ip.initializer) ||
              ts.isNoSubstitutionTemplateLiteral(ip.initializer))
          ) {
            copyIfMessageKey(msg, name, ip.initializer.text);
          }
          // else: key/value is not a string literal/identifier
        }
      });
      isValidMessage(msg) && messages.push(msg);
    }
  });
  return messages;
}

function extractMessagesForFormatMessage(
  objLiteral: ts.ObjectLiteralExpression,
): Message[] {
  const msg: Partial<Message> = {};
  objLiteral.properties.forEach((p) => {
    if (
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isLiteralExpression(p.name)) &&
      ts.isStringLiteral(p.initializer)
    ) {
      copyIfMessageKey(msg, p.name.text, p.initializer.text);
    }
    // else: key/value is not a string literal/identifier
  });
  return isValidMessage(msg) ? [msg] : [];
}

function extractMessagesForNode(
  node: ts.Node,
  extractMessages: MessageExtracter,
): Message[] {
  const res: Message[] = [];
  function find(n: ts.Node): Message[] | undefined {
    if (ts.isObjectLiteralExpression(n)) {
      res.push(...extractMessages(n));
      return undefined;
    } else {
      return ts.forEachChild(n, find);
    }
  }
  find(node);
  return res;
}

function forAllVarDecls(
  node: ts.Node,
  cb: (decl: ts.VariableDeclaration) => void,
) {
  if (ts.isVariableDeclaration(node)) {
    cb(node);
  } else {
    ts.forEachChild(node, (n) => forAllVarDecls(n, cb));
  }
}

function findJsxOpeningLikeElementsWithName(
  node: ts.SourceFile,
  tagName: ElementName,
) {
  const messages: ts.JsxOpeningLikeElement[] = [];
  function findJsxElement(n: ts.Node): undefined {
    // Is this a JsxElement with an identifier name?
    if (ts.isJsxOpeningLikeElement(n) && ts.isIdentifier(n.tagName)) {
      // Does the tag name match what we're looking for?
      const childTagName = n.tagName;
      if (childTagName.text === tagName) {
        messages.push(n);
      }
    }
    return ts.forEachChild(n, findJsxElement);
  }
  findJsxElement(node);
  return messages;
}

function findMethodCallsWithName(
  sourceFile: ts.SourceFile,
  methodName: MethodName,
  extractMessages: MessageExtracter,
) {
  let messages: Message[] = [];
  forAllVarDecls(sourceFile, (decl: ts.Declaration) => {
    if (isMethodCall(decl, methodName)) {
      if (
        decl.initializer &&
        ts.isCallExpression(decl.initializer) &&
        decl.initializer.arguments.length
      ) {
        const nodeProps = decl.initializer.arguments[0];
        const declMessages = extractMessagesForNode(nodeProps, extractMessages);
        messages = messages.concat(declMessages);
      }
    }
  });
  return messages;
}
export interface Options {
  tagNames: string[];
}
/**
 * Parse tsx files
 */
function main(
  contents: string,
  options: Options = { tagNames: [] },
): Message[] {
  const sourceFile = ts.createSourceFile(
    "file.ts",
    contents,
    ts.ScriptTarget.ES2015,
    /*setParentNodes */ false,
    ts.ScriptKind.TSX,
  );

  const dm = findMethodCallsWithName(
    sourceFile,
    "defineMessages",
    extractMessagesForDefineMessages,
  );

  // TODO formatMessage might not be the initializer for a VarDecl
  // eg console.log(formatMessage(...))
  const fm = findMethodCallsWithName(
    sourceFile,
    "formatMessage",
    extractMessagesForFormatMessage,
  );
  const results: Message[] = [];

  const tagNames = ["FormattedMessage"].concat(options.tagNames);
  tagNames.forEach((tagName) => {
    const elements = findJsxOpeningLikeElementsWithName(sourceFile, tagName);
    // convert JsxOpeningLikeElements to Message maps
    const jsxMessages = getElementsMessages(elements);
    results.push(...jsxMessages);
  });

  return results.concat(dm).concat(fm);
}

/**
 * convert JsxOpeningLikeElements to Message maps
 * @param elements
 */
function getElementsMessages(elements: ts.JsxOpeningLikeElement[]) {
  return elements
    .map((element) => {
      const msg: Partial<Message> = {};
      if (element.attributes) {
        element.attributes.properties.forEach((attr: ts.JsxAttributeLike) => {
          if (!ts.isJsxAttribute(attr) || !attr.initializer) {
            // Either JsxSpreadAttribute, or JsxAttribute without initializer.
            return;
          }
          const key = attr.name.text;
          const init = attr.initializer;
          let text;
          if (ts.isStringLiteral(init)) {
            text = init.text;
          } else if (ts.isJsxExpression(init)) {
            if (
              init.expression &&
              (ts.isStringLiteral(init.expression) ||
                ts.isNoSubstitutionTemplateLiteral(init.expression))
            ) {
              text = init.expression.text;
            } else {
              // Either the JsxExpression has no expression (?)
              // or a non-StringLiteral expression.
              return;
            }
          } else {
            // Should be a StringLiteral or JsxExpression, but it's not!
            return;
          }
          copyIfMessageKey(msg, key, text);
        });
      }
      return isValidMessage(msg) ? msg : null;
    })
    .filter(notNull);
}

function notNull<T>(value: T | null): value is T {
  return value !== null;
}

export default main;

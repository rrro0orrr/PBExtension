import { TestSuite, registerDefaultTests } from "@paperback/types/lib/impl/TestDefinition.js";
import { Doujins } from "../Doujins/main";
import sourceInfo from "../Doujins/pbconfig";

export async function runTests() {
  const suite = new TestSuite("Doujins tests");
  registerDefaultTests(suite, Doujins, sourceInfo);

  await suite.run();
}

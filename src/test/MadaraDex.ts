import { TestSuite, registerDefaultTests } from "@paperback/types/lib/impl/TestDefinition.js";
import { MadaraDex } from "../MadaraDex/main";
import sourceInfo from "../MadaraDex/pbconfig";

export async function runTests() {
  const suite = new TestSuite("MadaraDex tests");
  registerDefaultTests(suite, MadaraDex, sourceInfo);

  await suite.run();
}

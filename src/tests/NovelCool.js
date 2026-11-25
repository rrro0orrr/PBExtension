import { expect } from "chai";
import { NovelCool } from "../NovelCool/main.js";
import { TestSuite } from "./suite.js";
export async function runTests(logger) {
    const suite = new TestSuite("NovelCool tests", logger);
    const scheduleRequest = Application.scheduleRequest;
    suite.test("retries advanced search options after a failed request", async () => {
        let requests = 0;
        Application.scheduleRequest = async ({ url }) => {
            requests++;
            if (requests === 1)
                throw new Error("temporary failure");
            const body = new TextEncoder().encode("<html></html>").buffer;
            return [{ url, status: 200, headers: {}, cookies: [] }, body];
        };
        const query = { title: "" };
        const error = await NovelCool.getAdvancedSearchForm(query).catch((error) => error);
        expect(error).to.have.property("message", "temporary failure");
        expect(await NovelCool.getAdvancedSearchForm(query)).to.have.property("getSections");
        await NovelCool.getAdvancedSearchForm(query);
        expect(requests).to.equal(2);
    });
    try {
        await suite.run();
    }
    finally {
        Application.scheduleRequest = scheduleRequest;
    }
}

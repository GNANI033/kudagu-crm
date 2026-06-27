import unittest

from fastapi import HTTPException

from app import _normalize_pricing_calc_profile, _pricing_calc_publish_to_products, _pricing_calc_results


PRODUCTS = [
    {"id": "p1", "name": "Coorg Filter Coffee"},
]


class PricingCalculatorTests(unittest.TestCase):
    def test_pricing_formula_matches_workbook_shape(self):
        profile = _normalize_pricing_calc_profile(
            {
                "name": "Workbook Check",
                "inputs": {
                    "robustaCostPerKg": 560,
                    "arabicaCostPerKg": 790,
                    "chicoryCostPerKg": 180,
                    "processingCostPerKg": 100,
                    "bulkPackagingPerKg": 27,
                    "nonBulkPackagingPerKg": 80,
                    "bulkShippingPerKg": 65,
                    "nonBulkShippingPerKg": 110,
                    "baseTransportPerKg": 15,
                    "bulkMarginPct": 0.30,
                    "nonBulkMarginPct": 0.60,
                },
                "variants": [
                    {"id": "v250", "label": "250g", "grams": 250, "discountPct": 0, "isBase": True},
                    {"id": "v500", "label": "500g", "grams": 500, "discountPct": 0.085, "isBase": False},
                    {"id": "v1000", "label": "1kg", "grams": 1000, "discountPct": 0.085, "isBase": False},
                ],
                "rows": [
                    {"crmProductId": "p1", "robustaPct": 80, "arabicaPct": 0, "chicoryPct": 20, "enabled": True},
                ],
            },
            PRODUCTS,
            profile_id=1,
            allow_missing_products=False,
        )
        result = _pricing_calc_results(profile)["rows"][0]
        self.assertAlmostEqual(result["rawCoffeeCostPerKg"], 484.0, places=3)
        self.assertAlmostEqual(result["bulkMrpPerKg"], 878.8, places=3)
        self.assertAlmostEqual(result["variants"][0]["undiscountedMrp"], 315.6, places=3)
        self.assertAlmostEqual(result["variants"][0]["mrp"], 315.6, places=3)
        self.assertAlmostEqual(result["variants"][1]["undiscountedMrp"], 631.2, places=3)
        self.assertAlmostEqual(result["variants"][1]["mrp"], 577.548, places=3)
        self.assertAlmostEqual(result["variants"][2]["undiscountedMrp"], 1262.4, places=3)
        self.assertAlmostEqual(result["variants"][2]["mrp"], 1155.096, places=3)

    def test_rejects_bad_blend_total(self):
        with self.assertRaises(HTTPException):
            _normalize_pricing_calc_profile(
                {
                    "name": "Bad Blend",
                    "variants": [{"id": "v1", "label": "250g", "grams": 250, "discountPct": 0, "isBase": True}],
                    "rows": [{"crmProductId": "p1", "robustaPct": 60, "arabicaPct": 20, "chicoryPct": 10}],
                },
                PRODUCTS,
                profile_id=1,
                allow_missing_products=False,
            )

    def test_extra_costs_are_applied_by_scope(self):
        profile = _normalize_pricing_calc_profile(
            {
                "name": "Scoped Extras",
                "inputs": {
                    "robustaCostPerKg": 560,
                    "arabicaCostPerKg": 790,
                    "chicoryCostPerKg": 180,
                    "processingCostPerKg": 100,
                    "bulkPackagingPerKg": 27,
                    "nonBulkPackagingPerKg": 80,
                    "bulkShippingPerKg": 65,
                    "nonBulkShippingPerKg": 110,
                    "baseTransportPerKg": 15,
                    "bulkMarginPct": 0.30,
                    "nonBulkMarginPct": 0.60,
                },
                "extraCosts": [
                    {"label": "Handling", "amount": 10, "applyTo": "bulk"},
                    {"label": "Marketplace", "amount": 5, "applyTo": "nonBulk"},
                    {"label": "Wastage", "amount": 2, "applyTo": "both"},
                ],
                "variants": [{"id": "v250", "label": "250g", "grams": 250, "discountPct": 0, "isBase": True}],
                "rows": [{"crmProductId": "p1", "robustaPct": 100, "arabicaPct": 0, "chicoryPct": 0, "enabled": True}],
            },
            PRODUCTS,
            profile_id=1,
            allow_missing_products=False,
        )
        result = _pricing_calc_results(profile)["rows"][0]
        self.assertAlmostEqual(result["bulkMrpPerKg"], 993.2, places=3)
        self.assertAlmostEqual(result["variants"][0]["mrp"], 348.8, places=3)

    def test_round_to_five_rounds_prices_and_margin_upward(self):
        profile = _normalize_pricing_calc_profile(
            {
                "name": "Round Up",
                "roundToFive": True,
                "inputs": {
                    "robustaCostPerKg": 560,
                    "arabicaCostPerKg": 790,
                    "chicoryCostPerKg": 180,
                    "processingCostPerKg": 100,
                    "bulkPackagingPerKg": 27,
                    "nonBulkPackagingPerKg": 80,
                    "bulkShippingPerKg": 65,
                    "nonBulkShippingPerKg": 110,
                    "baseTransportPerKg": 15,
                    "bulkMarginPct": 0.30,
                    "nonBulkMarginPct": 0.60,
                },
                "variants": [
                    {"id": "v250", "label": "250g", "grams": 250, "discountPct": 0, "isBase": True},
                    {"id": "v500", "label": "500g", "grams": 500, "discountPct": 0.085, "isBase": False},
                ],
                "rows": [
                    {"crmProductId": "p1", "robustaPct": 100, "arabicaPct": 0, "chicoryPct": 0, "enabled": True},
                ],
            },
            PRODUCTS,
            profile_id=1,
            allow_missing_products=False,
        )
        result = _pricing_calc_results(profile)["rows"][0]
        self.assertAlmostEqual(result["bulkMrpPerKg"], 980.0, places=3)
        self.assertAlmostEqual(result["variants"][0]["undiscountedMrp"], 350.0, places=3)
        self.assertAlmostEqual(result["variants"][0]["mrp"], 350.0, places=3)
        self.assertAlmostEqual(result["variants"][1]["undiscountedMrp"], 695.0, places=3)
        self.assertAlmostEqual(result["variants"][1]["mrp"], 640.0, places=3)
        self.assertAlmostEqual(result["variants"][0]["marginRupees"], 132.5, places=3)

    def test_non_bulk_effective_margin_mode_uses_margin_on_selling_price(self):
        profile = _normalize_pricing_calc_profile(
            {
                "name": "Effective Margin",
                "nonBulkMarginMode": "effective",
                "inputs": {
                    "robustaCostPerKg": 560,
                    "arabicaCostPerKg": 790,
                    "chicoryCostPerKg": 180,
                    "processingCostPerKg": 100,
                    "bulkPackagingPerKg": 27,
                    "nonBulkPackagingPerKg": 80,
                    "bulkShippingPerKg": 65,
                    "nonBulkShippingPerKg": 110,
                    "baseTransportPerKg": 15,
                    "bulkMarginPct": 0.30,
                    "nonBulkMarginPct": 0.60,
                },
                "variants": [
                    {"id": "v250", "label": "250g", "grams": 250, "discountPct": 0, "isBase": True},
                ],
                "rows": [
                    {"crmProductId": "p1", "robustaPct": 100, "arabicaPct": 0, "chicoryPct": 0, "enabled": True},
                ],
            },
            PRODUCTS,
            profile_id=1,
            allow_missing_products=False,
        )
        result = _pricing_calc_results(profile)["rows"][0]
        self.assertEqual(profile["nonBulkMarginMode"], "effective")
        self.assertAlmostEqual(result["variants"][0]["costPerPack"], 216.25, places=3)
        self.assertAlmostEqual(result["variants"][0]["mrp"], 540.625, places=3)
        self.assertAlmostEqual(result["variants"][0]["marginRupees"], 324.375, places=3)

    def test_requires_single_base_variant(self):
        profile = _normalize_pricing_calc_profile(
            {
                "name": "Auto Base",
                "variants": [
                    {"id": "v1", "label": "500g", "grams": 500, "discountPct": 0.085, "isBase": True},
                    {"id": "v2", "label": "250g", "grams": 250, "discountPct": 0, "isBase": False},
                ],
                "rows": [{"crmProductId": "p1", "robustaPct": 100, "arabicaPct": 0, "chicoryPct": 0}],
            },
            PRODUCTS,
            profile_id=1,
            allow_missing_products=False,
        )
        self.assertEqual(profile["variants"][0]["isBase"], False)
        self.assertEqual(profile["variants"][1]["isBase"], True)

    def test_publish_updates_matching_product_sizes_and_skips_disabled_rows(self):
        data = {
            "products": [
                {
                    "id": "p1",
                    "name": "Coorg Filter Coffee",
                    "sizes": ["250g", "500g", "1kg"],
                    "pricing": {
                        "250g": {"mrp": 0, "bulkPrice": 0, "salePrices": {"retail": 10, "website": 11, "whatsapp": 12}},
                        "500g": {"mrp": 0, "bulkPrice": 0, "salePrices": {"retail": 20, "website": 21, "whatsapp": 22}},
                        "1kg": {"mrp": 0, "bulkPrice": 0, "salePrices": {"retail": 30, "website": 31, "whatsapp": 32}},
                    },
                },
                {
                    "id": "p2",
                    "name": "Disabled Product",
                    "sizes": ["250g"],
                    "pricing": {"250g": {"mrp": 99, "bulkPrice": 88, "salePrices": {"retail": 1, "website": 2, "whatsapp": 3}}},
                },
            ],
        }
        profile = _normalize_pricing_calc_profile(
            {
                "name": "Publish",
                "inputs": {
                    "robustaCostPerKg": 560,
                    "arabicaCostPerKg": 790,
                    "chicoryCostPerKg": 180,
                    "processingCostPerKg": 100,
                    "bulkPackagingPerKg": 27,
                    "nonBulkPackagingPerKg": 80,
                    "bulkShippingPerKg": 65,
                    "nonBulkShippingPerKg": 110,
                    "baseTransportPerKg": 15,
                    "bulkMarginPct": 0.30,
                    "nonBulkMarginPct": 0.60,
                },
                "variants": [
                    {"id": "v250", "label": "250g", "grams": 250, "discountPct": 0, "isBase": True},
                    {"id": "v500", "label": "500g", "grams": 500, "discountPct": 0.085, "isBase": False},
                    {"id": "v1000", "label": "1000g", "grams": 1000, "discountPct": 0.085, "isBase": False},
                ],
                "rows": [
                    {"crmProductId": "p1", "robustaPct": 80, "arabicaPct": 0, "chicoryPct": 20, "enabled": True},
                    {"crmProductId": "p2", "robustaPct": 100, "arabicaPct": 0, "chicoryPct": 0, "enabled": False},
                ],
            },
            data["products"],
            profile_id=1,
            allow_missing_products=False,
        )
        updated_products, updated_count = _pricing_calc_publish_to_products(data, profile)

        self.assertEqual(updated_count, 1)
        self.assertEqual(len(updated_products), 1)
        pricing = data["products"][0]["pricing"]
        self.assertAlmostEqual(pricing["250g"]["mrp"], 315.6, places=3)
        self.assertAlmostEqual(pricing["500g"]["mrp"], 631.2, places=3)
        self.assertAlmostEqual(pricing["1kg"]["mrp"], 1262.4, places=3)
        self.assertAlmostEqual(pricing["250g"]["bulkPrice"], 219.7, places=3)
        self.assertAlmostEqual(pricing["500g"]["bulkPrice"], 439.4, places=3)
        self.assertAlmostEqual(pricing["1kg"]["bulkPrice"], 878.8, places=3)
        self.assertEqual(pricing["250g"]["calculatorManagedChannels"], ["website", "whatsapp"])
        self.assertEqual(pricing["250g"]["salePrices"]["retail"], 10)
        self.assertAlmostEqual(pricing["250g"]["salePrices"]["website"], 315.6, places=3)
        self.assertAlmostEqual(pricing["250g"]["salePrices"]["whatsapp"], 315.6, places=3)
        self.assertAlmostEqual(pricing["250g"]["expensesByChannel"]["website"][0]["cost"], 197.25, places=3)
        self.assertAlmostEqual(pricing["250g"]["expensesByChannel"]["whatsapp"][0]["cost"], 197.25, places=3)
        self.assertAlmostEqual(pricing["500g"]["expensesByChannel"]["website"][0]["cost"], 394.5, places=3)
        self.assertAlmostEqual(pricing["1kg"]["expensesByChannel"]["website"][0]["cost"], 789.0, places=3)
        self.assertAlmostEqual(pricing["500g"]["salePrices"]["website"], 577.548, places=3)
        self.assertAlmostEqual(pricing["500g"]["salePrices"]["whatsapp"], 577.548, places=3)
        self.assertAlmostEqual(pricing["1kg"]["salePrices"]["website"], 1155.096, places=3)
        self.assertAlmostEqual(pricing["1kg"]["salePrices"]["whatsapp"], 1155.096, places=3)
        self.assertEqual(data["products"][1]["pricing"]["250g"]["mrp"], 99)

    def test_publish_uses_rounded_prices_when_enabled(self):
        data = {
            "products": [
                {
                    "id": "p1",
                    "name": "Coorg Filter Coffee",
                    "sizes": ["250g", "500g", "1kg"],
                    "pricing": {
                        "250g": {"mrp": 0, "bulkPrice": 0, "salePrices": {"retail": 10, "website": 11, "whatsapp": 12}},
                        "500g": {"mrp": 0, "bulkPrice": 0, "salePrices": {"retail": 20, "website": 21, "whatsapp": 22}},
                        "1kg": {"mrp": 0, "bulkPrice": 0, "salePrices": {"retail": 30, "website": 31, "whatsapp": 32}},
                    },
                },
            ],
        }
        profile = _normalize_pricing_calc_profile(
            {
                "name": "Publish Rounded",
                "roundToFive": True,
                "inputs": {
                    "robustaCostPerKg": 560,
                    "arabicaCostPerKg": 790,
                    "chicoryCostPerKg": 180,
                    "processingCostPerKg": 100,
                    "bulkPackagingPerKg": 27,
                    "nonBulkPackagingPerKg": 80,
                    "bulkShippingPerKg": 65,
                    "nonBulkShippingPerKg": 110,
                    "baseTransportPerKg": 15,
                    "bulkMarginPct": 0.30,
                    "nonBulkMarginPct": 0.60,
                },
                "variants": [
                    {"id": "v250", "label": "250g", "grams": 250, "discountPct": 0, "isBase": True},
                    {"id": "v500", "label": "500g", "grams": 500, "discountPct": 0.085, "isBase": False},
                    {"id": "v1000", "label": "1000g", "grams": 1000, "discountPct": 0.085, "isBase": False},
                ],
                "rows": [
                    {"crmProductId": "p1", "robustaPct": 80, "arabicaPct": 0, "chicoryPct": 20, "enabled": True},
                ],
            },
            data["products"],
            profile_id=1,
            allow_missing_products=False,
        )

        updated_products, updated_count = _pricing_calc_publish_to_products(data, profile)

        self.assertEqual(updated_count, 1)
        self.assertEqual(len(updated_products), 1)
        pricing = data["products"][0]["pricing"]
        self.assertAlmostEqual(pricing["250g"]["mrp"], 320.0, places=3)
        self.assertAlmostEqual(pricing["500g"]["mrp"], 635.0, places=3)
        self.assertAlmostEqual(pricing["1kg"]["mrp"], 1270.0, places=3)
        self.assertAlmostEqual(pricing["250g"]["bulkPrice"], 220.0, places=3)
        self.assertAlmostEqual(pricing["500g"]["bulkPrice"], 440.0, places=3)
        self.assertAlmostEqual(pricing["1kg"]["bulkPrice"], 880.0, places=3)
        self.assertEqual(pricing["500g"]["calculatorManagedChannels"], ["website", "whatsapp"])
        self.assertAlmostEqual(pricing["250g"]["salePrices"]["website"], 320.0, places=3)
        self.assertAlmostEqual(pricing["250g"]["salePrices"]["whatsapp"], 320.0, places=3)
        self.assertAlmostEqual(pricing["250g"]["expensesByChannel"]["website"][0]["cost"], 216.25, places=3)
        self.assertAlmostEqual(pricing["500g"]["expensesByChannel"]["website"][0]["cost"], 432.5, places=3)
        self.assertAlmostEqual(pricing["1kg"]["expensesByChannel"]["website"][0]["cost"], 865.0, places=3)
        self.assertAlmostEqual(pricing["500g"]["salePrices"]["website"], 580.0, places=3)
        self.assertAlmostEqual(pricing["500g"]["salePrices"]["whatsapp"], 580.0, places=3)
        self.assertAlmostEqual(pricing["1kg"]["salePrices"]["website"], 1160.0, places=3)
        self.assertAlmostEqual(pricing["1kg"]["salePrices"]["whatsapp"], 1160.0, places=3)


if __name__ == "__main__":
    unittest.main()

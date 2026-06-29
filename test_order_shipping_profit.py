import unittest

from app import _billing_snapshot_for_order, _normalize_order_shipping, _order_profit, _total_cost_for_order


class OrderShippingProfitTests(unittest.TestCase):
    def setUp(self):
        self.products_by_id = {
            "p1": {
                "id": "p1",
                "name": "Coorg Filter Coffee",
                "pricing": {
                    "250g": {
                        "mrp": 220,
                        "salePrices": {"retail": 200, "website": 200},
                        "bulkPrice": 0,
                        "expenses": [{"name": "Base cost", "cost": 40}],
                        "expensesByChannel": {
                            "retail": [{"name": "Base cost", "cost": 40}],
                            "website": [{"name": "Base cost", "cost": 40}],
                        },
                        "shippingCostsByChannel": {"retail": 80, "website": 80},
                        "calculatorManagedChannels": [],
                        "reorderCycleDays": 10,
                    }
                },
            }
        }

    def test_profit_is_provisional_until_actual_shipping_is_entered(self):
        order = {
            "prodId": "p1",
            "variant": "250g",
            "qty": 1,
            "channel": "retail",
            "deliveryMethod": "delivery",
            "deliveryCharge": 50,
            "discount": 0,
            "commission": 0,
            "shipping": {"estimatedCost": 80},
        }

        profit = _order_profit(self.products_by_id, order, gateway_pct=0)
        snapshot = _billing_snapshot_for_order(self.products_by_id, order)

        self.assertEqual(profit, 130)
        self.assertEqual(snapshot["estimatedShippingCost"], 80)
        self.assertIsNone(snapshot["actualShippingCost"])
        self.assertTrue(snapshot["shippingProfitProvisional"])

    def test_profit_drops_when_actual_shipping_exceeds_estimate(self):
        order = {
            "prodId": "p1",
            "variant": "250g",
            "qty": 1,
            "channel": "retail",
            "deliveryMethod": "delivery",
            "deliveryCharge": 50,
            "discount": 0,
            "commission": 0,
            "shipping": {"estimatedCost": 80, "actualCost": 100},
        }

        profit = _order_profit(self.products_by_id, order, gateway_pct=0)
        snapshot = _billing_snapshot_for_order(self.products_by_id, order)

        self.assertEqual(profit, 110)
        self.assertEqual(snapshot["shippingVariance"], 20)
        self.assertFalse(snapshot["shippingProfitProvisional"])

    def test_profit_increases_when_actual_shipping_is_lower_than_estimate(self):
        order = {
            "prodId": "p1",
            "variant": "250g",
            "qty": 1,
            "channel": "retail",
            "deliveryMethod": "delivery",
            "deliveryCharge": 50,
            "discount": 0,
            "commission": 0,
            "shipping": {"estimatedCost": 80, "actualCost": 50},
        }

        profit = _order_profit(self.products_by_id, order, gateway_pct=0)

        self.assertEqual(profit, 160)

    def test_normalize_order_shipping_infers_estimate_from_product_metadata(self):
        order = {
            "prodId": "p1",
            "variant": "250g",
            "channel": "website",
            "deliveryMethod": "delivery",
        }

        shipping = _normalize_order_shipping({}, order=order, products_by_id=self.products_by_id)

        self.assertEqual(shipping["estimatedCost"], 80)
        self.assertIsNone(shipping["actualCost"])

    def test_pickup_orders_zero_out_shipping_costs(self):
        order = {
            "prodId": "p1",
            "variant": "250g",
            "qty": 1,
            "channel": "retail",
            "deliveryMethod": "pickup",
            "deliveryCharge": 0,
            "discount": 0,
            "commission": 0,
            "shipping": {"estimatedCost": 80, "actualCost": 100},
        }

        shipping = _normalize_order_shipping(order["shipping"], order=order, products_by_id=self.products_by_id)
        order["shipping"] = shipping
        snapshot = _billing_snapshot_for_order(self.products_by_id, order)

        self.assertEqual(shipping["estimatedCost"], 0)
        self.assertEqual(shipping["actualCost"], 0)
        self.assertFalse(snapshot["shippingProfitProvisional"])

    def test_calculator_managed_channels_do_not_double_count_shipping(self):
        self.products_by_id["p1"]["pricing"]["250g"]["expenses"] = [{"name": "Pricing calculator cost", "cost": 120}]
        self.products_by_id["p1"]["pricing"]["250g"]["expensesByChannel"]["website"] = [{"name": "Pricing calculator cost", "cost": 120}]
        self.products_by_id["p1"]["pricing"]["250g"]["calculatorManagedChannels"] = ["website"]
        order = {
            "prodId": "p1",
            "variant": "250g",
            "qty": 1,
            "channel": "website",
            "deliveryMethod": "delivery",
            "deliveryCharge": 0,
            "discount": 0,
            "commission": 0,
            "shipping": {"estimatedCost": 80},
        }

        self.assertEqual(_total_cost_for_order(self.products_by_id, order), 120)


if __name__ == "__main__":
    unittest.main()
